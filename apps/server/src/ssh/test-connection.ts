import type { Host } from '@app/shared';
import { HostConnection, type HostKeyRefusal, type HostConnectionOptions } from './host-connection';

/** What a one-off connection test found, phrased for the "Add host" dialog. */
export type ConnectionTestResult =
  | { ok: true }
  | {
      ok: false;
      /** What went wrong, for choosing the advice shown. */
      problem: 'host-key' | 'auth' | 'wrong-user' | 'unreachable' | 'other';
      message: string;
      hostKeyRefusal: HostKeyRefusal | null;
      /** For 'wrong-user': the user the server asked for (cloud images do this). */
      suggestedUser?: string;
    };

/**
 * Cloud images (AWS, Oracle, Lightsail…) accept the key for "root" but only
 * print this and disconnect, so a login alone does not prove the user works.
 */
const WRONG_USER = /log ?in as the user "?([a-z_][a-z0-9_.-]*)"?/i;
const READY_MARKER = '__ssh_ready__';

/** The user a cloud image asked for instead, if its output says so. */
export function suggestedUserFrom(output: string): string | undefined {
  return WRONG_USER.exec(output)?.[1];
}

const TEST_TIMEOUT_MS = 12_000;

/**
 * Tries one SSH connection with exactly the checks the fleet uses (strict
 * known_hosts, agent or key file), runs a harmless `echo` to make sure the
 * account really gives a shell, then disconnects.
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
        if (change.phase === 'connected') void checkShell();
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
    const checkShell = async () => {
      try {
        const result = await connection.exec(`echo ${READY_MARKER}`, '', 5_000);
        const output = `${result.stdout}
${result.stderr}`;
        const suggestedUser = output.includes(READY_MARKER) ? undefined : suggestedUserFrom(output);
        if (suggestedUser && suggestedUser !== host.user) {
          return finish({
            ok: false,
            problem: 'wrong-user',
            message: `${host.address} accepts this key but wants you to log in as "${suggestedUser}", not "${host.user}".`,
            hostKeyRefusal: null,
            suggestedUser,
          });
        }
      } catch {
        // Some restricted accounts refuse exec; the login itself worked.
      }
      finish({ ok: true });
    };

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
