import { lstat, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { BackupType } from '@app/shared';
import { expandHome } from '../../config/app-paths';
import { DEFAULT_IMAGES, runToEnd, shellQuote, type Runner } from '../runner';
import {
  fromProcess,
  intoProcess,
  type BackupContext,
  type BackupOutput,
  type FileIndex,
  type SourceAdapter,
  type SourceContext,
} from './types';

/** "node_modules", "*.log", "cache/**": matched against the name and the relative path. */
export function excludeMatcher(patterns: readonly string[]): (relPath: string) => boolean {
  const regexes = patterns.map((pattern) => {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§DOUBLESTAR§')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/§DOUBLESTAR§/g, '.*');
    return new RegExp(`^${source}$`);
  });
  return (relPath) => {
    if (regexes.length === 0) return false;
    const parts = relPath.split('/');
    return regexes.some((re) => re.test(relPath) || parts.some((part) => re.test(part)));
  };
}

/** What changed against the base index (incremental: previous backup; differential: last full). */
export function diffIndex(
  current: FileIndex,
  base: FileIndex | null,
): { include: string[]; deleted: string[] } {
  if (!base) return { include: Object.keys(current).sort(), deleted: [] };
  const include: string[] = [];
  for (const [path, [size, mtime, type]] of Object.entries(current)) {
    const before = base[path];
    if (!before || before[2] !== type) include.push(path);
    else if (type !== 'd' && (before[0] !== size || before[1] !== mtime)) include.push(path);
  }
  const deleted = Object.keys(base).filter((path) => !(path in current));
  return { include: include.sort(), deleted: deleted.sort() };
}

async function walkLocal(
  root: string,
  excluded: (rel: string) => boolean,
  signal: AbortSignal,
): Promise<FileIndex> {
  const index: FileIndex = {};
  const visit = async (dir: string) => {
    if (signal.aborted) throw new Error('cancelled');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (dir === root) throw error;
      return; // unreadable subfolder: skipped (logged by tar if it matters)
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (excluded(rel)) continue;
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) index[rel] = [0, Math.floor(info.mtimeMs), 'l'];
      else if (info.isDirectory()) {
        index[rel] = [0, Math.floor(info.mtimeMs), 'd'];
        await visit(full);
      } else if (info.isFile()) index[rel] = [info.size, Math.floor(info.mtimeMs), 'f'];
    }
  };
  await visit(root);
  return index;
}

/** GNU find on the server: type, size, mtime, path (NUL-separated). */
export function parseFindOutput(output: string): FileIndex {
  const index: FileIndex = {};
  for (const record of output.split('\0')) {
    if (!record) continue;
    const [type, size, mtime, ...rest] = record.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    const t = type === 'd' ? 'd' : type === 'l' ? 'l' : type === 'f' ? 'f' : null;
    if (!t) continue;
    index[path] = [t === 'f' ? Number(size) : 0, Math.floor(Number(mtime) * 1000), t];
  }
  return index;
}

const EMPTY_TAR = () => Readable.from([Buffer.alloc(1024)]);

function rootOf(context: SourceContext): string {
  const path = context.source.path ?? '';
  return context.runner.isLocal
    ? resolve(expandHome(path, context.connectorContext.homeDir))
    : path.replace(/\/+$/, '') || '/';
}

async function remoteHasGnu(runner: Runner): Promise<boolean> {
  const result = await runToEnd(
    runner,
    ['sh', '-c', 'find --version 2>/dev/null | head -1; tar --version 2>/dev/null | head -1'],
    {
      timeoutMs: 20_000,
    },
  ).catch(() => null);
  return Boolean(result && /GNU findutils/.test(result.stdout) && /GNU tar/.test(result.stdout));
}

export const filesAdapter: SourceAdapter = {
  kind: 'files',
  validate: (source) => {
    if (!source.path) return ['enter the folder or file to back up'];
    if (source.tool.runner !== 'local' && !source.path.startsWith('/'))
      return ['use an absolute path on the server (/srv/app)'];
    return [];
  },
  targetLabel: (source) =>
    `${source.path ?? 'folder'} on ${source.tool.runner === 'local' ? 'this machine' : source.tool.runner}`,
  async backup(context: BackupContext): Promise<BackupOutput> {
    const root = rootOf(context);
    const excluded = excludeMatcher(context.source.exclude);
    let type: BackupType = context.base ? context.type : 'full';
    if (context.type !== 'full' && !context.base)
      context.log('info', 'No earlier backup to build on: taking a full backup');

    let index: FileIndex | null = null;
    if (context.runner.isLocal) {
      const info = await lstat(root).catch(() => null);
      if (!info) throw new Error(`${root} does not exist on this machine`);
      if (!info.isDirectory()) throw new Error(`${root} is not a folder`);
      index = await walkLocal(root, excluded, context.signal);
    } else if (await remoteHasGnu(context.runner)) {
      const listing = await runToEnd(
        context.runner,
        [
          'sh',
          '-c',
          `cd ${shellQuote(root)} && find . -xdev -mindepth 1 \\( -type f -o -type d -o -type l \\) -printf '%y\\t%s\\t%T@\\t%P\\0'`,
        ],
        { timeoutMs: 10 * 60_000, maxBytes: 256 * 1024 * 1024 },
      );
      if (listing.code !== 0)
        throw new Error(`listing ${root} failed: ${listing.stderr.trim().slice(-300)}`);
      index = Object.fromEntries(
        Object.entries(parseFindOutput(listing.stdout)).filter(([p]) => !excluded(p)),
      );
    } else {
      if (type !== 'full')
        context.log('warn', 'The server has no GNU find/tar: taking a full backup instead');
      type = 'full';
    }

    if (index) {
      const { include, deleted } = diffIndex(
        index,
        type === 'full' ? null : (context.base?.fileIndex ?? null),
      );
      const bytes = include.reduce(
        (sum, p) => sum + (index![p]![2] === 'f' ? index![p]![0] : 0),
        0,
      );
      context.setTotal(bytes, true);
      context.log(
        'info',
        `${Object.keys(index).length.toLocaleString()} entries found; ${include.length.toLocaleString()} to store${
          type !== 'full' ? `, ${deleted.length} removed since the base backup` : ''
        } (${bytes.toLocaleString()} bytes of file data)`,
      );
      const details = { path: root, runner: context.runner.id, excluded: context.source.exclude };
      if (include.length === 0) {
        return {
          stream: EMPTY_TAR(),
          done: Promise.resolve(),
          contentFormat: 'tar',
          extension: '.tar',
          tool: 'tar',
          details,
          fileIndex: index,
          deleted,
          fileCount: 0,
          type,
        };
      }
      if (context.runner.isLocal) {
        const pack = tar.create(
          { cwd: root, portable: true, noDirRecurse: true, follow: false },
          include,
        );
        const stream = new PassThrough();
        const done = new Promise<void>((ok, fail) => {
          pack.on('error', (e: unknown) => {
            stream.destroy(e as Error);
            fail(e as Error);
          });
          pack.on('end', () => ok());
        });
        pack.pipe(stream);
        done.catch(() => undefined);
        return {
          stream,
          done,
          contentFormat: 'tar',
          extension: '.tar',
          tool: 'tar (node)',
          details,
          fileIndex: index,
          deleted,
          fileCount: include.length,
          type,
        };
      }
      const proc = await context.runner.spawn([
        'tar',
        '-C',
        root,
        '--null',
        '--no-recursion',
        '-T',
        '-',
        '-cf',
        '-',
      ]);
      proc.stdin.on('error', () => undefined);
      proc.stdin.end(include.join('\0') + '\0');
      const onAbort = () => proc.kill();
      context.signal.addEventListener('abort', onAbort, { once: true });
      const done = proc.done.then(({ code, stderr }) => {
        context.signal.removeEventListener('abort', onAbort);
        // GNU tar exits 1 when a file changed while being read: kept, with a warning.
        if (code === 1)
          context.log('warn', `tar: ${stderr.trim().split('\n').slice(-3).join(' · ')}`);
        else if (code !== 0)
          throw new Error(`tar failed (exit ${code}): ${stderr.trim().slice(-300)}`);
      });
      return {
        stream: proc.stdout,
        done,
        contentFormat: 'tar',
        extension: '.tar',
        tool: 'GNU tar',
        details,
        fileIndex: index,
        deleted,
        fileCount: include.length,
        type,
      };
    }

    const argv = [
      'tar',
      '-C',
      root,
      ...context.source.exclude.map((p) => `--exclude=${p}`),
      '-cf',
      '-',
      '.',
    ];
    const { stream, done } = fromProcess(await context.runner.spawn(argv), 'tar', context.signal);
    return {
      stream,
      done,
      contentFormat: 'tar',
      extension: '.tar',
      tool: 'tar',
      details: { path: root, runner: context.runner.id, excluded: context.source.exclude },
      type: 'full',
    };
  },
  async restore(context, input) {
    const root = rootOf(context);
    if (context.runner.isLocal) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(root, { recursive: true });
      await pipeline(input, tar.extract({ cwd: root, preservePaths: false }));
    } else {
      await intoProcess(
        await context.runner.spawn([
          'sh',
          '-c',
          `mkdir -p ${shellQuote(root)} && tar -C ${shellQuote(root)} -xpf -`,
        ]),
        input,
        'tar -x',
        context.signal,
      );
    }
    const deleted = context.manifest.deleted ?? [];
    if (context.applyDeletions && deleted.length > 0) {
      const safe = deleted.filter((p) => !p.split('/').includes('..') && !isAbsolute(p));
      if (context.runner.isLocal) {
        for (const rel of safe) {
          const full = resolve(root, rel);
          if (full.startsWith(root))
            await rm(full, { force: true, recursive: false }).catch(() => undefined);
        }
      } else {
        const proc = await context.runner.spawn([
          'sh',
          '-c',
          `cd ${shellQuote(root)} && xargs -0 rm -f --`,
        ]);
        await intoProcess(
          proc,
          Readable.from([Buffer.from(safe.join('\0') + '\0')]),
          'removing deleted files',
          context.signal,
        );
      }
      context.log('info', `Removed ${safe.length} file(s) deleted before this backup`);
    }
  },
  async check(context) {
    const root = rootOf(context);
    if (context.runner.isLocal) {
      const index = await walkLocal(root, () => false, context.signal);
      return `${Object.keys(index).length.toLocaleString()} entries in ${root}`;
    }
    const result = await runToEnd(
      context.runner,
      ['sh', '-c', `find ${shellQuote(root)} | wc -l`],
      { timeoutMs: 120_000 },
    );
    return `${result.stdout.trim()} entries in ${root}`;
  },
};

// ── Docker ────────────────────────────────────────────────────────────────

const helper = DEFAULT_IMAGES.helper!;

export const dockerVolumeAdapter: SourceAdapter = {
  kind: 'docker-volume',
  validate: (source) => (source.dockerName ? [] : ['choose the volume']),
  targetLabel: (source) =>
    `volume ${source.dockerName} on ${source.tool.runner === 'local' ? 'this machine' : source.tool.runner}`,
  async backup(context) {
    const name = context.source.dockerName!;
    const size = await runToEnd(
      context.runner,
      ['docker', 'run', '--rm', '-v', `${name}:/data:ro`, helper, 'du', '-sk', '/data'],
      {
        timeoutMs: 5 * 60_000,
      },
    ).catch(() => null);
    if (size?.code === 0) {
      const kb = Number(size.stdout.trim().split(/\s+/)[0]);
      if (Number.isFinite(kb)) context.setTotal(kb * 1024, true);
    } else if (size && /No such volume|not found/i.test(size.stderr)) {
      throw new Error(`volume "${name}" does not exist on ${context.runner.label}`);
    }
    context.log(
      'info',
      `Archiving volume "${name}" with a temporary ${helper} container (read-only mount)`,
    );
    const proc = await context.runner.spawn([
      'docker',
      'run',
      '--rm',
      '-v',
      `${name}:/data:ro`,
      helper,
      'tar',
      '-C',
      '/data',
      '-cf',
      '-',
      '.',
    ]);
    const { stream, done } = fromProcess(proc, 'docker run tar', context.signal);
    return {
      stream,
      done,
      contentFormat: 'tar of the volume',
      extension: '.tar',
      tool: 'docker + tar',
      details: { volume: name, runner: context.runner.id },
    };
  },
  async restore(context, input) {
    const name = context.source.dockerName!;
    await runToEnd(context.runner, ['docker', 'volume', 'create', name], { timeoutMs: 60_000 });
    const proc = await context.runner.spawn([
      'docker',
      'run',
      '--rm',
      '-i',
      '-v',
      `${name}:/data`,
      helper,
      'tar',
      '-C',
      '/data',
      '-xpf',
      '-',
    ]);
    await intoProcess(proc, input, 'docker run tar -x', context.signal);
  },
  async check(context) {
    const r = await runToEnd(
      context.runner,
      [
        'docker',
        'run',
        '--rm',
        '-v',
        `${context.source.dockerName}:/data:ro`,
        helper,
        'sh',
        '-c',
        'find /data | wc -l',
      ],
      { timeoutMs: 120_000 },
    );
    return `${r.stdout.trim()} entries in volume ${context.source.dockerName}`;
  },
};

interface DockerInspect {
  Config?: {
    Image?: string;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    ExposedPorts?: Record<string, unknown>;
  };
  Mounts?: { Name?: string; Source?: string; Destination: string }[];
}

interface InspectSummary {
  image: string | null;
  cmd: string[] | null;
  entrypoint: string[] | null;
  workingDir: string | null;
  exposedPorts: string[];
  mounts: string[];
}

export const dockerContainerAdapter: SourceAdapter = {
  kind: 'docker-container',
  validate: (source) => (source.dockerName ? [] : ['choose the container']),
  targetLabel: (source) =>
    `a new image "${source.dockerName}-restored" on ${source.tool.runner === 'local' ? 'this machine' : source.tool.runner}`,
  async backup(context) {
    const name = context.source.dockerName!;
    const inspect = await runToEnd(context.runner, ['docker', 'inspect', name], {
      timeoutMs: 60_000,
    });
    if (inspect.code !== 0)
      throw new Error(`container "${name}" not found on ${context.runner.label}`);
    const raw = (JSON.parse(inspect.stdout) as DockerInspect[])[0] ?? {};
    // Environment variables are left out on purpose: they often hold passwords.
    const summary: InspectSummary = {
      image: raw.Config?.Image ?? null,
      cmd: raw.Config?.Cmd ?? null,
      entrypoint: raw.Config?.Entrypoint ?? null,
      workingDir: raw.Config?.WorkingDir || null,
      exposedPorts: Object.keys(raw.Config?.ExposedPorts ?? {}),
      mounts: (raw.Mounts ?? []).map((m) => `${m.Name ?? m.Source} → ${m.Destination}`),
    };
    if (summary.mounts.length > 0) {
      context.log(
        'warn',
        `Volumes are not part of a container export (${summary.mounts.join(', ')}): back them up as volumes`,
      );
    }
    context.log('info', `docker export ${name} (image ${summary.image})`);
    const { stream, done } = fromProcess(
      await context.runner.spawn(['docker', 'export', name]),
      'docker export',
      context.signal,
    );
    return {
      stream,
      done,
      contentFormat: 'docker export (container filesystem tar)',
      extension: '.tar',
      tool: 'docker export',
      details: { container: name, ...summary, environment: 'not saved (may contain secrets)' },
    };
  },
  async restore(context, input) {
    const name = context.source.dockerName || (context.manifest.source.details.container as string);
    const d = context.manifest.source.details as unknown as InspectSummary;
    const tag = `${name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}-restored:${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
    const changes: string[] = [];
    if (d.workingDir) changes.push('--change', `WORKDIR ${d.workingDir}`);
    if (d.entrypoint) changes.push('--change', `ENTRYPOINT ${JSON.stringify(d.entrypoint)}`);
    if (d.cmd) changes.push('--change', `CMD ${JSON.stringify(d.cmd)}`);
    for (const port of d.exposedPorts ?? []) changes.push('--change', `EXPOSE ${port}`);
    const proc = await context.runner.spawn(['docker', 'import', ...changes, '-', tag]);
    await intoProcess(proc, input, 'docker import', context.signal);
    context.log(
      'info',
      `Image ${tag} created. Start it with: docker run -d --name ${name}-restored ${tag}`,
    );
  },
};

// ── Custom command ────────────────────────────────────────────────────────

function shellArgv(runner: Runner, command: string): string[] {
  return runner.posix ? ['sh', '-c', command] : ['cmd.exe', '/d', '/s', '/c', command];
}

export const customAdapter: SourceAdapter = {
  kind: 'custom',
  validate: (source) =>
    source.backupCommand?.trim() ? [] : ['enter the command that writes the backup to stdout'],
  targetLabel: (source) =>
    `the restore command on ${source.tool.runner === 'local' ? 'this machine' : source.tool.runner}`,
  async backup(context) {
    const command = context.source.backupCommand!;
    context.log('info', `Running the custom backup command on ${context.runner.label}`);
    const env: Record<string, string> = context.password
      ? { BACKUP_PASSWORD: context.password }
      : {};
    const { stream, done } = fromProcess(
      await context.runner.spawn(shellArgv(context.runner, command), env),
      'the backup command',
      context.signal,
    );
    return {
      stream,
      done,
      contentFormat: 'custom command output',
      extension: '.bin',
      tool: 'custom',
      details: { runner: context.runner.id },
    };
  },
  async restore(context, input) {
    const command = context.source.restoreCommand?.trim();
    if (!command)
      throw new Error(
        'this job has no restore command: add one to the job (it reads the backup on stdin)',
      );
    const env: Record<string, string> = context.password
      ? { BACKUP_PASSWORD: context.password }
      : {};
    await intoProcess(
      await context.runner.spawn(shellArgv(context.runner, command), env),
      input,
      'the restore command',
      context.signal,
    );
  },
};
