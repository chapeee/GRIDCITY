import type { Host } from '@app/shared';
import { HostConnection, type HostKeyRefusal, type HostConnectionOptions } from './host-connection';

/** What a one-off connection test found, phrased for the "Add host" dialog. */
export type ConnectionTestResult =
  | { ok: true }
  | {
      ok: false;
      /** What went wrong, for choosing the advice shown. */
      problem: 'host-key' | 'auth' | 'unreachable' | 'other';
      message: string;
      hostKeyRefusal: HostKeyRefusal | null;
    };

const TEST_TIMEOUT_MS = 12_000;

/**
 * Tries one SSH connection with exactly the checks the fleet uses (strict
 * known_hosts, agent or key file), then disconnects. Runs nothing on the host.
 */
export function testConnection(
  host: Host,
  options: Pick<HostConnectionOptions, 'loadKnownHosts' | 'buildAuth' | 'createClient'>,
): Promise<ConnectionTestResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ConnectionTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.stop();
      resolve(result);
    };

    const connection = new HostConnection({
      host,
      ...options,
      readyTimeoutMs: 10_000,
      onPhaseChange: (change) => {
        if (change.phase === 'connected') finish({ ok: true });
        if (change.phase === 'failed') {
          const message = change.error ?? 'connection failed';
          finish({
            ok: false,
            problem: change.hostKeyRefusal
              ? 'host-key'
              : /authentication|agent|key file|passphrase/i.test(message)
                ? 'auth'
                : /ECONNREFUSED|ETIMEDOUT|resolve|unreachable|timed out/i.test(message)
                  ? 'unreachable'
                  : 'other',
            message,
            hostKeyRefusal: change.hostKeyRefusal,
          });
        }
      },
    });
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          problem: 'unreachable',
          message: `No answer from ${host.address}:${host.port} within ${TEST_TIMEOUT_MS / 1000} s.`,
          hostKeyRefusal: null,
        }),
      TEST_TIMEOUT_MS,
    );
    connection.start();
  });
}
