/**
 * localStorage access that never throws. Storage can be missing or blocked
 * (private windows, strict settings); the app must work without it, so
 * everything stored here is a convenience, never required state.
 */

export function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the value simply is not remembered.
  }
}
