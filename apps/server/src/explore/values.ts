import type { SqlValue } from '@app/shared';

/** Binary values are shown as a preview: this many bytes travel to the browser. */
const BINARY_PREVIEW_BYTES = 256;
/** Long text is cut so one huge cell cannot freeze the grid. */
const TEXT_LIMIT = 64 * 1024;

/** Any driver value -> JSON the browser can show (and send back for edits). */
export function toJsonValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string')
    return value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    // Exact as a number when it fits; otherwise text, so no digit is lost.
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return {
      $binary: bytes.subarray(0, BINARY_PREVIEW_BYTES).toString('base64'),
      bytes: bytes.length,
    };
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    // Driver objects with a meaningful text form (decimals, intervals, points…).
    const text = (value as { toJSON?: () => unknown }).toJSON?.();
    if (text !== undefined && text !== value) return toJsonValue(text);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(inner);
    }
    return out;
  }
  return String(value);
}

/** A value from the browser for a write. Binary previews are never written back. */
export function fromJsonValue(value: SqlValue): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && '$binary' in value) {
    throw new Error('binary values cannot be edited here');
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}
