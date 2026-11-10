import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import ssh2, { type Connection } from 'ssh2';

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
  /** Drops every client connection (simulates a network cut / server restart). */
  dropAllClients(): void;
  close(): Promise<void>;
}

const FIXTURES = ['debian-poll-1', 'debian-poll-2'].map((name) =>
  readFileSync(new URL(`../metrics/fixtures/${name}.txt`, import.meta.url), 'utf8'),
);

export async function startFakeSshServer(options: {
  /** Public key (OpenSSH format) the server accepts for `user`. */
  authorizedKey: string;
  user: string;
}): Promise<FakeSshServer> {
  const hostKeys = utils.generateKeyPairSync('ed25519');
  const authorized = utils.parseKey(options.authorizedKey);
  if (authorized instanceof Error) throw authorized;
  const authorizedBlob = authorized.getPublicSSH();
  const clients = new Set<Connection>();

  const fake: FakeSshServer = {
    port: 0,
    hostPublicKey: hostKeys.public,
    knownHostsLine: '',
    execBehavior: 'fixtures',
    execCount: 0,
    lastWindow: null,
    shellLines: [],
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

    client.on('authentication', (context) => {
      const keyMatches =
        context.method === 'publickey' &&
        context.username === options.user &&
        context.key.algo === authorized.type &&
        context.key.data.length === authorizedBlob.length &&
        timingSafeEqual(context.key.data, authorizedBlob);
      if (!keyMatches) return context.reject(['publickey']);
      if (!context.signature) return context.accept(); // key probe
      const valid = authorized.verify(context.blob!, context.signature, context.hashAlgo);
      return valid === true ? context.accept() : context.reject(['publickey']);
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
        session.on('exec', (acceptExec) => {
          const stream = acceptExec();
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
