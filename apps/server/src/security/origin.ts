/** Hostnames the browser may use to reach this machine. */
const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'] as const;

/**
 * Origins allowed to open WebSockets and make state-changing requests: this
 * machine on the server port (production) or the Vite dev port. A page on
 * any other origin, even one that knows the token, is refused.
 */
export function buildAllowedOrigins(ports: readonly number[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const port of ports) {
    for (const hostname of LOCAL_HOSTNAMES) origins.add(`http://${hostname}:${port}`);
  }
  return origins;
}

/** Missing origins are refused: browsers always send one on these requests. */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin !== undefined && allowed.has(origin.toLowerCase());
}

/** Requests that need an Origin check: WebSocket upgrades and anything that is not a read. */
export function requiresOriginCheck(method: string, upgradeHeader: string | undefined): boolean {
  return (
    upgradeHeader?.toLowerCase() === 'websocket' || !['GET', 'HEAD', 'OPTIONS'].includes(method)
  );
}
