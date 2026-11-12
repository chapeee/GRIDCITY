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
