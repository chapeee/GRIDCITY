import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import type { ToolConfig } from '@app/shared';

/**
 * Where backup commands run: this machine, or a server over its existing
 * SSH connection. Secrets travel as environment variables and never appear
 * in a command line (`ps` on the server shows no password):
 * - locally they are set in the child's environment;
 * - over SSH they are written to a 0600 file under ~/.cache/gridcity first,
 *   sourced by the shell and deleted before the tool starts.
 */
export interface Proc {
  stdout: Readable;
  stdin: Writable;
  /** Resolves when the process exits (never rejects); stderr keeps the last 64 KiB. */
  done: Promise<{ code: number | null; stderr: string }>;
  kill(): void;
}

export interface Runner {
  /** "local" or the server id. */
  readonly id: string;
  readonly label: string;
  readonly isLocal: boolean;
  /** POSIX shell available (every SSH server; local only off Windows). */
  readonly posix: boolean;
  spawn(argv: string[], env?: Record<string, string>): Promise<Proc>;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const STDERR_KEEP = 64 * 1024;
const keepTail = (current: string, chunk: Buffer) => {
  const next = current + chunk.toString('utf8');
  return next.length > STDERR_KEEP ? next.slice(next.length - STDERR_KEEP) : next;
};

/** POSIX single-quote quoting. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const shellLine = (argv: string[]) => argv.map(shellQuote).join(' ');

/** Runs to the end, collecting output (for short commands: checks, listings). */
export async function runToEnd(
  runner: Runner,
  argv: string[],
  options: {
    env?: Record<string, string>;
    stdin?: string | Buffer;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<RunResult> {
  const proc = await runner.spawn(argv, options.env);
  const max = options.maxBytes ?? 8 * 1024 * 1024;
  let stdout = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < max) stdout += chunk.toString('utf8');
  });
  proc.stdin.on('error', () => undefined);
  proc.stdin.end(options.stdin ?? '');
  const timeoutMs = options.timeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${argv[0]} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  try {
    const { code, stderr } = await Promise.race([proc.done, timeout]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export class LocalRunner implements Runner {
  readonly id = 'local';
  readonly label = 'this machine';
  readonly isLocal = true;
  readonly posix = process.platform !== 'win32';

  spawn(argv: string[], env: Record<string, string> = {}): Promise<Proc> {
    const [command, ...args] = argv;
    if (!command) return Promise.reject(new Error('empty command'));
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr = keepTail(stderr, chunk)));
      let started = false;
      const done = new Promise<{ code: number | null; stderr: string }>((finish) => {
        child.on('close', (code) => finish({ code, stderr }));
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (!started) {
          reject(
            error.code === 'ENOENT'
              ? new Error(`"${command}" is not installed on this machine (or not on PATH)`)
              : error,
          );
        } else stderr = keepTail(stderr, Buffer.from(`\n${error.message}`));
      });
      child.on('spawn', () => {
        started = true;
        resolve({
          stdout: child.stdout,
          stdin: child.stdin,
          done,
          kill: () => child.kill('SIGKILL'),
        });
      });
    });
  }
}

/** The pieces of HostConnection a runner needs (tests pass a fake). */
export interface SshExecutor {
  openExec(command: string): Promise<ClientChannel>;
}

export class SshRunner implements Runner {
  readonly isLocal = false;
  readonly posix = true;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly connection: () => SshExecutor | undefined,
  ) {}

  private async open(command: string): Promise<Proc> {
    const connection = this.connection();
    if (!connection) throw new Error(`${this.label} is not connected over SSH right now`);
    const channel = await connection.openExec(command);
    let stderr = '';
    channel.stderr.on('data', (chunk: Buffer) => (stderr = keepTail(stderr, chunk)));
    let exitCode: number | null = null;
    channel.on('exit', (code: number | null) => {
      exitCode = code;
    });
    const done = new Promise<{ code: number | null; stderr: string }>((finish) => {
      channel.on('close', (code?: number | null) =>
        finish({ code: exitCode ?? code ?? null, stderr }),
      );
    });
    // The channel is a duplex: reading is stdout, writing is stdin.
    const stdout = new PassThrough();
    channel.pipe(stdout);
    return {
      stdout,
      stdin: channel,
      done,
      kill: () => {
        try {
          channel.signal('KILL');
        } catch {
          // not every server honours signals
        }
        channel.close();
      },
    };
  }

  async spawn(argv: string[], env: Record<string, string> = {}): Promise<Proc> {
    const names = Object.keys(env);
    if (names.length === 0) return this.open(shellLine(argv));
    for (const name of names) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad variable name ${name}`);
    }
    const file = `"$HOME/.cache/gridcity/env-${randomBytes(8).toString('hex')}"`;
    const content = names.map((name) => `export ${name}=${shellQuote(env[name] ?? '')}\n`).join('');
    const stage = await this.open(`umask 077 && mkdir -p "$HOME/.cache/gridcity" && cat > ${file}`);
    stage.stdout.resume();
    stage.stdin.end(content);
    const staged = await stage.done;
    if (staged.code !== 0) {
      throw new Error(`could not prepare the command on ${this.label}: ${staged.stderr.trim()}`);
    }
    return this.open(`. ${file}; rm -f ${file}; exec ${shellLine(argv)}`);
  }
}

/** Default images for docker-image mode. */
export const DEFAULT_IMAGES: Record<string, string> = {
  postgres: 'postgres:17-alpine',
  mysql: 'mysql:8.4',
  mariadb: 'mariadb:11',
  mongodb: 'mongo:8.0',
  firebird: 'firebirdsql/firebird:5',
  helper: 'alpine:3.20',
};

/**
 * Wraps a tool command for the configured mode. `env` names are passed into
 * the container by name only (`-e NAME`), so values never reach a command line.
 */
export function wrapForMode(
  argv: string[],
  envNames: string[],
  tool: ToolConfig,
  runner: Runner,
  defaultImage: string,
  options: { interactive?: boolean } = {},
): string[] {
  const envArgs = envNames.flatMap((name) => ['-e', name]);
  const interactive = options.interactive === false ? [] : ['-i'];
  if (tool.mode === 'docker-exec') {
    if (!tool.container) throw new Error('docker exec needs the container name');
    return ['docker', 'exec', ...interactive, ...envArgs, tool.container, ...argv];
  }
  if (tool.mode === 'docker-image') {
    const network =
      runner.isLocal && process.platform !== 'linux'
        ? ['--add-host=host.docker.internal:host-gateway']
        : ['--network', 'host'];
    return [
      'docker',
      'run',
      '--rm',
      ...interactive,
      ...network,
      ...envArgs,
      tool.image || defaultImage,
      ...argv,
    ];
  }
  return argv;
}

/**
 * Docker Desktop (Windows, macOS) runs containers in a VM: "localhost" there
 * is the container. A throwaway tool container reaches this machine through
 * host.docker.internal instead.
 */
export function hostForMode(host: string, tool: ToolConfig, runner: Runner): string {
  if (
    tool.mode === 'docker-image' &&
    runner.isLocal &&
    process.platform !== 'linux' &&
    /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(host)
  ) {
    return 'host.docker.internal';
  }
  return host;
}
