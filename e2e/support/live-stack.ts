import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import {
  startFakeSshServer,
  type FakeSshServer,
} from '../../apps/server/src/testing/fake-ssh-server';
import { makePpk } from '../../apps/server/src/testing/ppk-fixture';

/**
 * A complete local stack for browser tests: two in-process SSH servers
 * (one trusted in known_hosts, one not), a real hosts.yaml, and the *built*
 * server process pointed at them. Requires `npm run build` first.
 */
export interface LiveStack {
  url: string;
  /** Trusted host "lab-01". */
  trusted: FakeSshServer;
  /** Host "stranger", whose key is deliberately not in known_hosts. */
  untrusted: FakeSshServer;
  /** A freshly installed server: password only, no keys, not in known_hosts. */
  fresh: FakeSshServer;
  /** A cloud-style server (no passwords) that accepts `cloudKeyPpk`. */
  cloud: FakeSshServer;
  /** The PuTTY key file a provider would hand out for `cloud`. */
  cloudKeyPpk: string;
  stopServer(): Promise<void>;
  /** Everything the server printed (for diagnosing failures). */
  serverOutput(): string;
  close(): Promise<void>;
}

const PORT = 4698;
const USER = 'ops';
/** Password of the fresh server in the connect-a-server test. */
export const FRESH_PASSWORD = 'fresh-server-password';

export async function startLiveStack(): Promise<LiveStack> {
  const workDir = mkdtempSync(join(tmpdir(), 'live-stack-'));
  // Client test keys are ECDSA: rarely, a freshly generated ed25519 key failed ssh2's
  // connect-time parse in parallel test runs (not reproducible directly; real keys unaffected).
  const keys = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
  const keyFile = join(workDir, 'id_ed25519');
  writeFileSync(keyFile, keys.private, { mode: 0o600 });

  const trusted = await startFakeSshServer({ authorizedKey: keys.public, user: USER });
  const untrusted = await startFakeSshServer({ authorizedKey: keys.public, user: USER });
  const fresh = await startFakeSshServer({ user: 'root', password: FRESH_PASSWORD });
  const cloudKey = makePpk('ed25519', { comment: 'cloud-provider-key' });
  const cloud = await startFakeSshServer({ user: 'ubuntu', authorizedKey: cloudKey.publicLine });

  const configDir = join(workDir, 'config');
  const knownHosts = join(workDir, 'known_hosts');
  writeFileSync(knownHosts, `${trusted.knownHostsLine}\n`);
  const host = (id: string, port: number) =>
    `  - id: ${id}\n    name: ${id}\n    address: 127.0.0.1\n    port: ${port}\n    user: ${USER}\n    district: Lab\n    auth: { method: keyFile, path: '${keyFile.replace(/'/g, "''")}' }\n`;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'hosts.yaml'),
    `thresholds:\n  pollIntervalMs: 1000\nhosts:\n${host('lab-01', trusted.port)}${host('stranger', untrusted.port)}`,
  );

  const server: ChildProcess = spawn(process.execPath, ['apps/server/dist/index.js'], {
    env: {
      ...process.env,
      DATA_MODE: 'real',
      SERVER_PORT: String(PORT),
      CONFIG_DIR: configDir,
      DATA_DIR: join(workDir, 'data'),
      KNOWN_HOSTS_FILE: knownHosts,
      // A private SSH folder and no agent: tests never see the developer's real keys.
      SSH_DIR: join(workDir, 'ssh'),
      SSH_AUTH_SOCK:
        process.platform === 'win32'
          ? '\\\\.\\pipe\\no-agent-for-tests'
          : '/nonexistent/agent.sock',
      LOG_LEVEL: process.env.LIVE_LOG_LEVEL ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout?.on('data', (chunk) => (output += chunk));
  server.stderr?.on('data', (chunk) => (output += chunk));

  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const check = setInterval(() => {
      const match = /token=([\w-]+)/.exec(output);
      if (match?.[1]) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(match[1]);
      }
    }, 50);
    server.once('exit', (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });

  const stopServer = async () => {
    if (server.exitCode !== null) return;
    server.kill();
    await Promise.race([once(server, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
  };

  return {
    url: `http://127.0.0.1:${PORT}/?token=${token}`,
    trusted,
    untrusted,
    fresh,
    cloud,
    cloudKeyPpk: cloudKey.ppk,
    stopServer,
    serverOutput: () => output,
    async close() {
      await stopServer();
      await trusted.close();
      await untrusted.close();
      await fresh.close();
      await cloud.close();
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Windows may still hold the database briefly; a leftover temp dir is harmless.
      }
    },
  };
}
