export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** ± spread applied to every delay so many hosts do not reconnect in lockstep. */
  jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0.2 };

/**
 * Exponential backoff with jitter: base × 2^attempt, capped at maxMs.
 * attempt 0 is the first retry after a failure.
 */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt));
  const jitter = 1 + (random() * 2 - 1) * options.jitterRatio;
  return Math.round(Math.min(options.maxMs, exponential * jitter));
}
