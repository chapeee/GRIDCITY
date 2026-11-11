import {
  AppSettingsSchema,
  createDemoHistory,
  HistoryResponseSchema,
  type AppSettings,
  type HistoryResponse,
  type StatusThresholds,
} from '@app/shared';
import { useServerLink } from './server-link';

/**
 * History, settings and host edits: the server JSON API, or, for the
 * in-browser demo, generated DEMO DATA (never mixed with real data).
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
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

const inBrowserDemo = () => useServerLink.getState().source !== 'server';

/** History of one host/resource (or every incident with `targetId` null) over `days`. */
export async function fetchHistory(
  targetId: string | null,
  days: number,
): Promise<HistoryResponse> {
  if (inBrowserDemo()) {
    const { useFleetStore } = await import('./fleet-store');
    const { hosts, resources } = useFleetStore.getState();
    const ids = [...hosts.map((h) => h.id), ...resources.map((r) => r.id)];
    return createDemoHistory(ids, targetId, Date.now(), days);
  }
  const query = new URLSearchParams({
    days: String(days),
    ...(targetId ? { target: targetId } : {}),
  });
  return HistoryResponseSchema.parse(await request(`/api/history?${query.toString()}`));
}

export interface SettingsView {
  app: AppSettings;
  /** File-wide thresholds from hosts.yaml (what "degraded" means by default). */
  thresholds: StatusThresholds;
  /** False in demo mode: there is no hosts.yaml to write. */
  editable: boolean;
  /** The alert webhook (its URL is a secret and never comes back). */
  alerts?: { webhookConfigured: boolean; fromEnvironment: boolean };
  hostsFile?: string;
}

export async function fetchSettings(): Promise<SettingsView> {
  if (inBrowserDemo()) {
    const { useFleetStore } = await import('./fleet-store');
    return {
      app: AppSettingsSchema.parse({}),
      thresholds: useFleetStore.getState().thresholds,
      editable: false,
    };
  }
  return request<SettingsView>('/api/settings');
}

export const saveSettings = (body: {
  app?: Partial<AppSettings>;
  thresholds?: Partial<StatusThresholds>;
  alerts?: { webhookUrl: string | null };
}) => request<SettingsView>('/api/settings', { method: 'PUT', body: JSON.stringify(body) });

/** Sends one test message to the saved webhook. */
export const sendTestAlert = () =>
  request<{ ok: true }>('/api/alerts/test', { method: 'POST', body: '{}' });

export interface HostPatch {
  name?: string;
  district?: string;
  tags?: string[];
  thresholds?: Partial<
    Pick<
      StatusThresholds,
      'cpuDegradedPercent' | 'cpuDegradedPolls' | 'memoryDegradedPercent' | 'diskDegradedPercent'
    >
  > | null;
}

export const editHost = (id: string, patch: HostPatch) =>
  request<{ ok: true }>(`/api/hosts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const removeHost = (id: string) =>
  request<{ ok: true }>(`/api/hosts/${encodeURIComponent(id)}`, { method: 'DELETE' });
