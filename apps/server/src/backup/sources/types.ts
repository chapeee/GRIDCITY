import type { Readable } from 'node:stream';
import type { BackupManifest, BackupSourceKind, BackupType, SourceConfig } from '@app/shared';
import type { ResourceConfig } from '../../config/resources-file';
import type { ConnectorContext } from '../../connectors/connector';
import type { Proc, Runner } from '../runner';

/** Path → [size, mtime ms, type] for files incremental / differential backups. */
export type FileIndex = Record<string, [number, number, 'f' | 'd' | 'l']>;

export interface SourceContext {
  source: SourceConfig;
  /** The resources.yaml entry the source points to (databases), resolved. */
  resource: ResourceConfig | undefined;
  /** Password from the vault / env / file of that entry, or the job's own. */
  password: string | undefined;
  /** Where the tool runs. */
  runner: Runner;
  connectorContext: ConnectorContext;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  signal: AbortSignal;
}

export interface BackupContext extends SourceContext {
  type: BackupType;
  /** The job's strategy (a full in a differential job is the base of the next ones). */
  strategy: BackupType;
  /** Incremental / differential: the backup this one builds on. */
  base: { runId: string; manifest: BackupManifest; fileIndex: FileIndex | null } | null;
  /** Report the source's size when it is known (never a guess). */
  setTotal(bytes: number | null, estimate: boolean): void;
}

export interface BackupOutput {
  stream: Readable;
  /** Resolves when the tool finished successfully; rejects with its error otherwise. */
  done: Promise<void>;
  contentFormat: string;
  /** File extension before compression/encryption (".dump", ".sql", ".tar"…). */
  extension: string;
  tool: string | null;
  details: Record<string, unknown>;
  /** Files: the index to remember for the next incremental / differential. */
  fileIndex?: FileIndex;
  deleted?: string[];
  fileCount?: number;
  /** The type actually produced (a files incremental without a base becomes full). */
  type?: BackupType;
}

export interface RestoreContext extends SourceContext {
  manifest: BackupManifest;
  /** Position in a chain (full, then incrementals / the differential). */
  chainIndex: number;
  chainLength: number;
  applyDeletions: boolean;
  createDatabase: boolean;
}

export interface SourceAdapter {
  kind: BackupSourceKind;
  /** Problems with the configuration, before anything runs. */
  validate(source: SourceConfig, resource: ResourceConfig | undefined): string[];
  /** "orders-db / shop on this machine": what the user confirms before a restore. */
  targetLabel(source: SourceConfig, resource: ResourceConfig | undefined): string;
  backup(context: BackupContext): Promise<BackupOutput>;
  /** Restores one artifact (raw bytes, already decrypted and decompressed). */
  restore(context: RestoreContext, input: Readable): Promise<void>;
  /** After a restore: a short proof that the data is there ("12 tables"). */
  check?(context: RestoreContext): Promise<string>;
}

/**
 * Turns a running tool into a backup stream: stdout is the backup, and the
 * exit code decides whether it succeeded (stderr becomes the error).
 */
export function fromProcess(
  proc: Proc,
  what: string,
  signal: AbortSignal,
): {
  stream: Readable;
  done: Promise<void>;
} {
  proc.stdin.on('error', () => undefined);
  proc.stdin.end();
  const onAbort = () => proc.kill();
  signal.addEventListener('abort', onAbort, { once: true });
  const done = proc.done.then(({ code, stderr }) => {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) throw new Error('cancelled');
    if (code !== 0) throw new Error(toolError(what, code, stderr));
  });
  return { stream: proc.stdout, done };
}

/** Feeds `input` into a tool's stdin and waits for a clean exit. */
export async function intoProcess(
  proc: Proc,
  input: Readable,
  what: string,
  signal: AbortSignal,
): Promise<string> {
  let stdout = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8');
  });
  const onAbort = () => proc.kill();
  signal.addEventListener('abort', onAbort, { once: true });
  proc.stdin.on('error', () => undefined); // the tool may exit early; its exit code tells why
  input.on('error', () => proc.kill());
  input.pipe(proc.stdin);
  const { code, stderr } = await proc.done;
  signal.removeEventListener('abort', onAbort);
  if (signal.aborted) throw new Error('cancelled');
  if (code !== 0) throw new Error(toolError(what, code, stderr));
  return stdout;
}

export function toolError(what: string, code: number | null, stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // Noise every tool prints.
    .filter((line) => !/Using a password on the command line|deprecated/i.test(line));
  const tail = lines.slice(-4).join(' · ');
  if (code === 127 || /not found|No such file or directory.*exec/i.test(stderr)) {
    return `${what} is not installed where it runs (${tail || `exit ${code}`}). Choose Docker mode or install the tool.`;
  }
  return `${what} failed (exit ${code ?? 'killed'})${tail ? `: ${tail}` : ''}`;
}

/** Lines for the run log (stderr of a successful tool: warnings worth seeing). */
export function warnLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/password on the command line/i.test(l))
    .slice(-10);
}
