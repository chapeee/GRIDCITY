/**
 * Display formatting. Every formatter renders `null` as an em dash so
 * unknown values are never mistaken for zero.
 */

export const UNKNOWN = '—';

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** 1536 -> "1.5 KiB". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return UNKNOWN;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unitIndex]}`;
}

/** Throughput, e.g. "2.4 MiB/s". */
export function formatRate(bytesPerSec: number | null): string {
  return bytesPerSec === null ? UNKNOWN : `${formatBytes(bytesPerSec)}/s`;
}

/** 42.37 -> "42%". */
export function formatPercent(percent: number | null): string {
  return percent === null ? UNKNOWN : `${Math.round(percent)}%`;
}

/** Compact duration: "45s", "12m", "5h", "3d". */
export function formatDurationShort(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Uptime, e.g. "12d 4h" or "3h 20m". */
export function formatUptime(seconds: number | null): string {
  if (seconds === null) return UNKNOWN;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "last seen 45s ago", or "never seen". */
export function formatLastSeen(lastSeenAt: number | null, now: number): string {
  return lastSeenAt === null
    ? 'never seen'
    : `last seen ${formatDurationShort(now - lastSeenAt)} ago`;
}
