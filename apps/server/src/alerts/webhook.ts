import type { HostStatus } from '@app/shared';

/** One status transition worth telling someone about. */
export interface AlertEvent {
  targetId: string;
  targetName: string;
  /** "server", "PostgreSQL", "ALB"… */
  kind: string;
  district: string;
  from: HostStatus | null;
  to: HostStatus;
  reason: string | null;
  at: number;
}

export interface WebhookNotifierOptions {
  url: string;
  projectName: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** The same target is not reported again within this window (flapping protection). */
  quietMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_QUIET_MS = 60_000;

/**
 * Posts status transitions to a webhook (Slack, Discord, Mattermost, ntfy or
 * anything that takes JSON). Fire and forget: a failing webhook is logged
 * once and never slows the fleet. The payload carries `text` and `content`,
 * which is what the common chat webhooks read, plus the structured fields.
 */
export function createWebhookNotifier(options: WebhookNotifierOptions) {
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const lastSent = new Map<string, number>();
  let warned = false;

  return {
    notify(event: AlertEvent): boolean {
      // Only transitions a human would act on: into or out of trouble.
      const matters =
        event.to === 'offline' ||
        event.to === 'degraded' ||
        (event.to === 'online' && (event.from === 'offline' || event.from === 'degraded'));
      if (!matters) return false;
      const at = now();
      const last = lastSent.get(event.targetId);
      if (last !== undefined && at - last < quietMs && event.to !== 'offline') return false;
      lastSent.set(event.targetId, at);

      const text = describe(event, options.projectName);
      void send(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          content: text,
          project: options.projectName,
          target: event.targetId,
          name: event.targetName,
          kind: event.kind,
          district: event.district,
          from: event.from,
          status: event.to,
          reason: event.reason,
          at: new Date(event.at).toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      })
        .then((response) => {
          if (!response.ok && !warned) {
            warned = true;
            options.log?.(`alert webhook answered ${response.status}`);
          }
        })
        .catch((error: Error) => {
          if (warned) return;
          warned = true;
          options.log?.(`alert webhook failed: ${error.message}`);
        });
      return true;
    },
  };
}

const ICONS: Record<HostStatus, string> = {
  offline: '🔴',
  degraded: '🟡',
  online: '🟢',
  unknown: '⚪',
};

export function describe(event: AlertEvent, projectName: string): string {
  const what = `${event.targetName} (${event.kind}, ${event.district})`;
  switch (event.to) {
    case 'offline':
      return `${ICONS.offline} ${projectName}: ${what} is OFFLINE${event.reason ? ` — ${event.reason}` : ''}`;
    case 'degraded':
      return `${ICONS.degraded} ${projectName}: ${what} is degraded${event.reason ? ` — ${event.reason}` : ''}`;
    case 'online':
      return `${ICONS.online} ${projectName}: ${what} is back online${event.from ? ` (was ${event.from})` : ''}`;
    default:
      return `${ICONS.unknown} ${projectName}: ${what} is ${event.to}`;
  }
}
