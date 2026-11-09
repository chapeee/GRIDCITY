import { useEffect, useState } from 'react';

/**
 * Current time, refreshed every `intervalMs`. Drives "last seen" labels and
 * client-side staleness, so a host freezes even if the server goes silent.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
