import type { BackupSourceKind, DiscoveredItem, DiscoveryResult, SourceConfig } from '@app/shared';
import type { ResourceConfig } from '../config/resources-file';
import { errorMessage } from '../connectors/connector';
import { runToEnd, type Runner } from './runner';
import type { JobRecord } from './store';

/** Database images recognised in `docker ps`, and the source they become. */
const IMAGE_KINDS: [RegExp, BackupSourceKind][] = [
  [/(^|\/)(postgres|postgis|timescale)/i, 'postgres'],
  [/(^|\/)(mysql|mariadb|percona)/i, 'mysql'],
  [/(^|\/)mongo/i, 'mongodb'],
  [/(^|\/)(redis|valkey|keydb)/i, 'redis'],
  [/mssql|sql-server|azure-sql-edge/i, 'mssql'],
  [/firebird/i, 'firebird'],
];

const DB_KINDS = new Set(['postgres', 'mysql', 'mongodb', 'redis', 'mssql', 'sqlite']);
const FILE_CANDIDATES = [
  '/etc',
  '/var/www',
  '/srv',
  '/opt',
  '/home',
  '/root',
  '/var/lib/docker/volumes',
];

interface DockerContainer {
  Names: string;
  Image: string;
  State: string;
  Ports: string;
}

interface DockerVolume {
  Name: string;
  Driver: string;
}

export interface DiscoveryDeps {
  resources(): Promise<ReadonlyMap<string, ResourceConfig>>;
  /** Runners to scan: this machine and every connected server. */
  runners(): Runner[];
  jobs(): JobRecord[];
}

function parseJsonLines<T>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((v): v is NonNullable<typeof v> => v !== null) as T[];
}

const samePlace = (a: Partial<SourceConfig>, b: SourceConfig) =>
  a.kind === b.kind &&
  (a.resourceId ?? null) === (b.resourceId ?? null) &&
  (a.dockerName ?? null) === (b.dockerName ?? null) &&
  (a.path ?? null) === (b.path ?? null) &&
  (a.tool?.container ?? null) === (b.tool.container ?? null) &&
  (a.tool?.runner ?? 'local') === b.tool.runner;

/** Published host ports of a container ("0.0.0.0:15432->5432/tcp" → 15432). */
export function publishedPorts(ports: string): number[] {
  return [...ports.matchAll(/:(\d+)->/g)].map((m) => Number(m[1]));
}

export async function discover(deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const items: DiscoveredItem[] = [];
  const problems: DiscoveryResult['problems'] = [];
  const resources = [...(await deps.resources()).values()];
  const runners = deps.runners();
  const localDocker = await runToEnd(
    runners[0]!,
    ['docker', 'version', '--format', '{{.Server.Version}}'],
    { timeoutMs: 10_000 },
  )
    .then((r) => r.code === 0)
    .catch(() => false);

  // Databases already connected in GRIDCITY (their saved credentials are reused).
  for (const resource of resources) {
    if (!DB_KINDS.has(resource.kind)) continue;
    const kind = resource.kind as BackupSourceKind;
    const mode =
      kind === 'mongodb' || kind === 'redis' || kind === 'sqlite'
        ? 'driver'
        : kind === 'mssql'
          ? 'docker-exec'
          : localDocker
            ? 'docker-image'
            : 'native';
    const where =
      'host' in resource
        ? `${resource.host}:${resource.port}`
        : 'path' in resource
          ? resource.path
          : 'url' in resource
            ? resource.url.replace(/\/\/[^@/]*@/, '//')
            : '';
    items.push({
      key: `resource:${resource.id}`,
      label: resource.name ?? resource.id,
      detail: `${kind} · connected resource`,
      where,
      source: { kind, resourceId: resource.id, tool: { runner: 'local', mode } },
      coveredBy: [],
    });
  }

  // Docker on this machine and on every connected server.
  await Promise.all(
    runners.map(async (runner) => {
      const label = runner.label;
      if (runner.isLocal && !localDocker) return;
      try {
        const ps = await runToEnd(runner, ['docker', 'ps', '-a', '--format', '{{json .}}'], {
          timeoutMs: 20_000,
        });
        if (ps.code !== 0) {
          if (!runner.isLocal && !/command not found|not found/i.test(ps.stderr)) {
            problems.push({
              where: label,
              message: `docker: ${ps.stderr.trim().split('\n').pop()}`,
            });
          }
        } else {
          for (const c of parseJsonLines<DockerContainer>(ps.stdout)) {
            const name = c.Names.split(',')[0]!;
            const dbKind = IMAGE_KINDS.find(([re]) => re.test(c.Image))?.[1];
            if (dbKind) {
              const ports = publishedPorts(c.Ports);
              const match = resources.find(
                (r) => r.kind === dbKind && 'port' in r && ports.includes(r.port as number),
              );
              items.push({
                key: `container-db:${runner.id}:${name}`,
                label: `${name}`,
                detail: `${dbKind} in a container (${c.Image}) · ${c.State}${match ? ` · uses the login of "${match.name ?? match.id}"` : ''}`,
                where: label,
                source: {
                  kind: dbKind,
                  ...(match ? { resourceId: match.id } : {}),
                  tool: {
                    runner: runner.id,
                    mode: dbKind === 'redis' ? 'driver' : 'docker-exec',
                    container: name,
                  },
                },
                coveredBy: [],
              });
            }
            items.push({
              key: `container:${runner.id}:${name}`,
              label: name,
              detail: `container filesystem (${c.Image}) · ${c.State}`,
              where: label,
              source: {
                kind: 'docker-container',
                dockerName: name,
                tool: { runner: runner.id, mode: 'native' },
              },
              coveredBy: [],
            });
          }
          const volumes = await runToEnd(
            runner,
            ['docker', 'volume', 'ls', '--format', '{{json .}}'],
            { timeoutMs: 20_000 },
          );
          for (const v of parseJsonLines<DockerVolume>(volumes.stdout)) {
            items.push({
              key: `volume:${runner.id}:${v.Name}`,
              label: v.Name,
              detail: `docker volume (${v.Driver})`,
              where: label,
              source: {
                kind: 'docker-volume',
                dockerName: v.Name,
                tool: { runner: runner.id, mode: 'native' },
              },
              coveredBy: [],
            });
          }
        }
        if (!runner.isLocal) {
          const dirs = await runToEnd(
            runner,
            [
              'sh',
              '-c',
              `for d in ${FILE_CANDIDATES.join(' ')}; do [ -d "$d" ] && [ -r "$d" ] && echo "$d"; done; exit 0`,
            ],
            { timeoutMs: 15_000 },
          );
          for (const dir of dirs.stdout
            .split('\n')
            .map((d) => d.trim())
            .filter(Boolean)) {
            items.push({
              key: `files:${runner.id}:${dir}`,
              label: dir,
              detail: 'folder',
              where: label,
              source: { kind: 'files', path: dir, tool: { runner: runner.id, mode: 'native' } },
              coveredBy: [],
            });
          }
        }
      } catch (error) {
        problems.push({ where: label, message: errorMessage(error) });
      }
    }),
  );

  const jobs = deps.jobs();
  for (const item of items) {
    item.coveredBy = jobs.filter((j) => samePlace(item.source, j.config.source)).map((j) => j.name);
  }
  return { items, problems, scannedAt: Date.now() };
}
