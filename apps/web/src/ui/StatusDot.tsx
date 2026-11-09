import type { HostStatus } from '@app/shared';

/** Small status indicator; colors come from the status CSS classes. */
export function StatusDot({ status, stale = false }: { status: HostStatus; stale?: boolean }) {
  return (
    <span
      className={`status-dot status-${status}${stale ? ' is-stale' : ''}`}
      aria-label={stale ? `${status}, stale` : status}
      role="img"
    />
  );
}
