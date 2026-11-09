/** Addresses that only accept connections from this machine. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1']);

/** Wildcard address a container must bind so Docker can forward the port. */
const CONTAINER_WILDCARD = '0.0.0.0';

export type BindDecision = { allowed: true; warning?: string } | { allowed: false; reason: string };

/**
 * Enforces the local-first rule: the server listens on loopback only.
 *
 * The single exception is inside our Docker image, where the container's own
 * loopback is unreachable from the host. There we bind 0.0.0.0 inside the
 * container and compose publishes it on the host's 127.0.0.1 only.
 */
export function decideBind(host: string, insideContainer: boolean): BindDecision {
  if (LOOPBACK_ADDRESSES.has(host)) return { allowed: true };

  if (insideContainer && host === CONTAINER_WILDCARD) {
    return {
      allowed: true,
      warning:
        'Binding 0.0.0.0 inside the container. Publish the port on 127.0.0.1 only ' +
        '(the provided compose files do this).',
    };
  }

  return {
    allowed: false,
    reason:
      `Refusing to bind "${host}". This server only listens on 127.0.0.1 or ::1 ` +
      'so nothing outside this machine can reach your SSH sessions.',
  };
}
