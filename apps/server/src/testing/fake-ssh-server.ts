import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, type AddressInfo } from 'node:net';
import ssh2, { type Connection, type ParsedKey } from 'ssh2';

const { Server, utils } = ssh2;

/**
 * A real SSH server running in-process, for end-to-end tests of the
 * connection manager and poller. It speaks the actual SSH protocol (key
 * exchange, host key, public key auth, exec channels), but instead of a
 * shell it answers the collector script with captured fixture output.
 *
 * Test support only: never imported by the server itself.
 */

export type ExecBehavior =
  /** Answer with alternating real captures, so CPU and network deltas exist. */
  | 'fixtures'
  /** Accept the command and never answer (a stuck poller). */
  | 'stall'
  /** Answer with output that is not collector output. */
  | 'garbage';

export interface FakeSshServer {
  port: number;
  /** "ssh-ed25519 AAAA…" of the server's host key. */
  hostPublicKey: string;
  /** known_hosts line trusting this server. */
  knownHostsLine: string;
  execBehavior: ExecBehavior;
  /** Number of exec requests served. */
  execCount: number;
  /** Last PTY size requested (open or window change), or null. */
  lastWindow: { cols: number; rows: number } | null;
  /** Lines received by the fake shell, in order. */
  shellLines: string[];
  /** Public keys installed through the authorized_keys script. */
  installedKeys: number;
  /** Tunnels opened through this server (as a jump host). */
  tunnelsOpened: number;
  /** Drops every client connection (simulates a network cut / server restart). */
  dropAllClients(): void;
  close(): Promise<void>;
}

const FIXTURES = ['debian-poll-1', 'debian-poll-2'].map((name) =>
  readFileSync(new URL(`../metrics/fixtures/${name}.txt`, import.meta.url), 'utf8'),
);

/**
 * An ed25519 host key that ssh2 can parse back. Rarely, ssh2's generator
 * produces a key its own parser rejects ("Malformed OpenSSH private key"),
 * which made tests flaky; real keys from ssh-keygen are not affected.
 */
function generateUsableHostKey(): ReturnType<typeof utils.generateKeyPairSync> {
  for (;;) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
}

export async function startFakeSshServer(options: {
  /** Public key (OpenSSH format) the server accepts for `user`, if any. */
  authorizedKey?: string;
  user: string;
  /** Accept this password (plain and keyboard-interactive), like a fresh server. */
  password?: string;
  /**
   * Like an AWS image: also accept the key for "root", but every command run
   * as root only prints "Please login as the user <this>" and fails.
   */
  cloudUser?: string;
  /** Allow direct-tcpip tunnels, like a bastion (`ssh -J`). */
  allowTunnels?: boolean;
}): Promise<FakeSshServer> {
  const hostKeys = generateUsableHostKey();
  /** Like ~/.ssh/authorized_keys: grows when a key is installed over SSH. */
  const authorizedKeys: ParsedKey[] = [];
  const authorize = (publicKey: string) => {
    const parsed = utils.parseKey(publicKey);
    if (parsed instanceof Error) throw parsed;
    authorizedKeys.push(parsed);
  };
  if (options.authorizedKey) authorize(options.authorizedKey);
  const clients = new Set<Connection>();

  const fake: FakeSshServer = {
    port: 0,
    hostPublicKey: hostKeys.public,
    knownHostsLine: '',
    execBehavior: 'fixtures',
    execCount: 0,
    lastWindow: null,
    shellLines: [],
    installedKeys: 0,
    tunnelsOpened: 0,
    dropAllClients: () => {
      for (const client of clients) client.end();
    },
    close: () =>
      new Promise((resolve) => {
        fake.dropAllClients();
        server.close(() => resolve());
      }),
  };

  const server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    /** Who this client authenticated as (the cloud-image trick depends on it). */
    let loggedInAs = '';
    client.on('tcpip', (accept, reject, info) => {
      if (!options.allowTunnels) return reject();
      fake.tunnelsOpened += 1;
      const upstream = netConnect(info.destPort, info.destIP);
      upstream.once('connect', () => {
        const channel = accept();
        channel.pipe(upstream).pipe(channel);
        channel.on('close', () => upstream.destroy());
        upstream.on('close', () => channel.close());
      });
      upstream.once('error', () => reject());
    });

    const methods = options.password
      ? ['publickey', 'password', 'keyboard-interactive']
      : ['publickey'];
    client.on('authentication', (context) => {
      const cloudRoot = options.cloudUser !== undefined && context.username === 'root';
      if (context.username !== options.user && !cloudRoot) {
        return context.reject(methods as never);
      }
      loggedInAs = context.username;

      if (context.method === 'password') {
        return context.password === options.password
          ? context.accept()
          : context.reject(methods as never);
      }
      if (context.method === 'keyboard-interactive' && options.password) {
        return context.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
          answers[0] === options.password ? context.accept() : context.reject(methods as never),
        );
      }
      if (context.method !== 'publickey') return context.reject(methods as never);

      const match = authorizedKeys.find((key) => {
        const blob = key.getPublicSSH();
        return (
          context.key.algo === key.type &&
          context.key.data.length === blob.length &&
          timingSafeEqual(context.key.data, blob)
        );
      });
      if (!match) return context.reject(methods as never);
      if (!context.signature) return context.accept(); // key probe
      const valid = match.verify(context.blob!, context.signature, context.hashAlgo);
      return valid === true ? context.accept() : context.reject(methods as never);
    });

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept, _reject, info) => {
          fake.lastWindow = { cols: info.cols, rows: info.rows };
          accept?.();
        });
        session.on('window-change', (accept, _reject, info) => {
          fake.lastWindow = { cols: info.cols, rows: info.rows };
          accept?.();
        });
        // A tiny line-based shell: echoes typing, answers each line, exits on "exit".
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          let line = '';
          stream.write('fake-shell ready\r\n$ ');
          stream.on('data', (chunk: Buffer) => {
            for (const character of chunk.toString('utf8')) {
              if (character !== '\r') {
                line += character;
                stream.write(character);
                continue;
              }
              stream.write('\r\n');
              fake.shellLines.push(line);
              if (line.trim() === 'exit') {
                stream.exit(0);
                stream.end();
                return;
              }
              stream.write(`you typed: ${line}\r\n$ `);
              line = '';
            }
          });
        });
        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          if (options.cloudUser && loggedInAs === 'root') {
            stream.write(
              `Please login as the user "${options.cloudUser}" rather than the user "root".

`,
            );
            stream.exit(142);
            stream.end();
            return;
          }
          if (info.command.startsWith('echo ')) {
            stream.write(`${info.command.slice(5)}
`);
            stream.exit(0);
            stream.end();
            return;
          }
          if (info.command.includes('authorized_keys')) {
            let input = '';
            stream.on('data', (chunk: Buffer) => (input += chunk.toString('utf8')));
            stream.once('end', () => {
              try {
                authorize(input.trim());
                fake.installedKeys += 1;
                stream.exit(0);
              } catch {
                stream.stderr.write('invalid key\n');
                stream.exit(1);
              }
              stream.end();
            });
            return;
          }
          const output = FIXTURES[fake.execCount % FIXTURES.length]!;
          fake.execCount += 1;
          if (fake.execBehavior === 'stall') return; // never answers
          stream.on('data', () => {}); // drain the script sent on stdin
          stream.once('end', () => {
            stream.write(fake.execBehavior === 'garbage' ? 'command not found\n' : output);
            stream.exit(0);
            stream.end();
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fake.port = (server.address() as AddressInfo).port;
  fake.knownHostsLine = `[127.0.0.1]:${fake.port} ${hostKeys.public.split(' ').slice(0, 2).join(' ')}`;
  return fake;
}
