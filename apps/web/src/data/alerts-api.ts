import type { AlertChannelInput, AlertsView, PushDeviceView } from '@app/shared';
import { readStoredJson, writeStoredJson } from '../ui/browser-storage';

/** Alert channels and Web Push: the server's /api/alerts routes. */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    problems?: string[];
  };
  if (!response.ok) {
    throw new Error(
      body.problems?.join('\n') ?? body.error ?? `${path} failed (${response.status})`,
    );
  }
  return body;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: JSON.stringify(body ?? {}) });

export const alertsApi = {
  load: () => request<AlertsView>('/api/alerts'),
  addChannel: (input: AlertChannelInput) => send<AlertsView>('POST', '/api/alerts/channels', input),
  editChannel: (id: string, input: AlertChannelInput) =>
    send<AlertsView>('PUT', `/api/alerts/channels/${encodeURIComponent(id)}`, input),
  removeChannel: (id: string) =>
    request<AlertsView>(`/api/alerts/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testChannel: (id: string) => send<{ ok: true }>('POST', '/api/alerts/test', { id }),
  testDraft: (input: AlertChannelInput, id: string | null) =>
    send<{ ok: true }>('POST', '/api/alerts/test', id ? { id, input } : { input }),
  removeDevice: (id: string) =>
    request<AlertsView>(`/api/alerts/push/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testDevice: (id: string) =>
    send<{ ok: true }>('POST', `/api/alerts/push/${encodeURIComponent(id)}/test`),
};

// ── Web Push in this browser ──────────────────────────────────────────

const DEVICE_KEY = 'gridcity.push-device';

/** Why push cannot work here, or null when it can. */
export function pushUnavailableReason(): string | null {
  if (typeof window === 'undefined') return 'no browser';
  if (!window.isSecureContext) {
    return 'needs https or localhost (open the app at http://127.0.0.1 or localhost, or behind https)';
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'this browser has no Web Push';
  }
  if (typeof Notification === 'undefined') return 'this browser has no notifications';
  return null;
}

/** The device id this browser registered with, if any. */
export const storedDeviceId = (): string | null => readStoredJson<string | null>(DEVICE_KEY, null);

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** "Chrome on Windows", so the device list makes sense to a person. */
export function describeThisBrowser(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\//.test(agent)
      ? 'Opera'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(agent)
    ? 'Windows'
    : /Android/.test(agent)
      ? 'Android'
      : /iPhone|iPad/.test(agent)
        ? 'iOS'
        : /Mac OS X/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** Asks for permission, subscribes, and registers this browser with the server. */
export async function enablePush(
  publicKey: string,
): Promise<{ device: PushDeviceView; view: AlertsView }> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the address bar (the lock icon), then try again.'
        : 'Notifications were not allowed.',
    );
  }
  const worker = await registration();
  let subscription = await worker.pushManager.getSubscription();
  const key = base64UrlToBytes(publicKey);
  // A subscription made with another server key cannot be used: start over.
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && !sameBytes(new Uint8Array(current), key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const result = await send<{ device: PushDeviceView; view: AlertsView }>(
    'POST',
    '/api/alerts/push',
    {
      subscription: subscription.toJSON(),
      label: describeThisBrowser(),
    },
  );
  writeStoredJson(DEVICE_KEY, result.device.id);
  return result;
}

/** Unsubscribes this browser here and on the server. */
export async function disablePush(): Promise<AlertsView | null> {
  const id = storedDeviceId();
  writeStoredJson(DEVICE_KEY, null);
  const worker = await navigator.serviceWorker.getRegistration('/');
  const subscription = await worker?.pushManager.getSubscription();
  await subscription?.unsubscribe().catch(() => false);
  if (!id) return null;
  return alertsApi.removeDevice(id).catch(() => null);
}

/** Is this browser still subscribed (the user can revoke it in browser settings)? */
export async function pushActiveHere(view: AlertsView): Promise<boolean> {
  const id = storedDeviceId();
  if (!id || pushUnavailableReason()) return false;
  if (Notification.permission !== 'granted') return false;
  const worker = await navigator.serviceWorker.getRegistration('/');
  const subscription = await worker?.pushManager.getSubscription();
  return Boolean(subscription) && view.push.devices.some((device) => device.id === id);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
