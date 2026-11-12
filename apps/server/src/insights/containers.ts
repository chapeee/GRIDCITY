import type { Host, ThreatSeverity } from '@app/shared';
import type { ThreatDraft } from '../threats/detect';
import type { InsightProducer, ProducerResult, SweepRunner } from '../threats/threat-hub';
import { insightDraft } from './expiry';

/** Docker and Kubernetes, read-only. `sudo -n` is tried for docker only when the user is not in the docker group. */
export const CONTAINERS_SCRIPT = `export LC_ALL=C
D=''
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then D='docker'; elif sudo -n docker info >/dev/null 2>&1; then D='sudo -n docker'; fi
fi
if ! command -v docker >/dev/null 2>&1; then echo '@@docker missing'
elif [ -z "$D" ]; then echo '@@docker denied'
else
  echo '@@docker ok'
  echo '@@inspect'
  IDS=$($D ps -aq 2>/dev/null)
  [ -n "$IDS" ] && $D inspect --format '{{.Name}}\t{{.Config.Image}}\t{{.State.Status}}\t{{.RestartCount}}\t{{.State.ExitCode}}\t{{.State.OOMKilled}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.HostConfig.RestartPolicy.Name}}\t{{.State.StartedAt}}' $IDS 2>/dev/null
  echo '@@stats'
  $D stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null
fi
if command -v kubectl >/dev/null 2>&1; then
  P=$(kubectl get pods -A -o json --request-timeout=10s 2>/dev/null)
  if [ -n "$P" ]; then echo '@@pods'; echo "$P"; else echo '@@kubectl denied'; fi
else echo '@@kubectl missing'; fi
echo '@@end'
`;

export interface ContainerInfo {
  name: string;
  image: string;
  state: string;
  restarts: number;
  exitCode: number;
  oomKilled: boolean;
  health: string | null;
  restartPolicy: string;
  startedAt: number | null;
  cpuPercent: number | null;
  memory: string | null;
}

export interface PodProblem {
  namespace: string;
  pod: string;
  reason: string;
  restarts: number;
  message: string | null;
}

export interface ContainerSnapshot {
  docker: 'ok' | 'missing' | 'denied';
  kubernetes: 'ok' | 'missing' | 'denied';
  containers: ContainerInfo[];
  pods: { total: number; problems: PodProblem[] };
}

export function parseContainers(output: string): ContainerSnapshot | null {
  if (!output.includes('@@end')) return null;
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const docker = (/^@@docker (\w+)/m.exec(output)?.[1] ?? 'missing') as ContainerSnapshot['docker'];
  const kubernetes: ContainerSnapshot['kubernetes'] = output.includes('@@pods')
    ? 'ok'
    : output.includes('@@kubectl denied')
      ? 'denied'
      : 'missing';
  const containers = new Map<string, ContainerInfo>();
  let section = '';
  const podLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      section = line.slice(2).split(' ')[0]!;
      continue;
    }
    if (section === 'inspect' && line.includes('\t')) {
      const [name, image, state, restarts, exitCode, oom, health, policy, started] =
        line.split('\t');
      const clean = (name ?? '').replace(/^\//, '');
      const startedAt = started ? Date.parse(started) : NaN;
      containers.set(clean, {
        name: clean,
        image: image ?? '',
        state: state ?? '',
        restarts: Number(restarts) || 0,
        exitCode: Number(exitCode) || 0,
        oomKilled: oom === 'true',
        health: health || null,
        restartPolicy: policy || 'no',
        startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
        cpuPercent: null,
        memory: null,
      });
    } else if (section === 'stats' && line.includes('\t')) {
      const [name, cpu, memory] = line.split('\t');
      const entry = containers.get(name ?? '');
      if (entry) {
        const value = Number.parseFloat((cpu ?? '').replace('%', ''));
        entry.cpuPercent = Number.isFinite(value) ? value : null;
        entry.memory = memory?.trim() || null;
      }
    } else if (section === 'pods') {
      podLines.push(line);
    }
  }
  return {
    docker,
    kubernetes,
    containers: [...containers.values()],
    pods: parsePods(podLines.join('\n')),
  };
}

const BAD_WAITING = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'InvalidImageName',
  'CreateContainerError',
]);

interface RawPods {
  items?: {
    metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
    status?: {
      phase?: string;
      containerStatuses?: {
        restartCount?: number;
        state?: { waiting?: { reason?: string; message?: string } };
        lastState?: { terminated?: { reason?: string } };
      }[];
    };
  }[];
}

export function parsePods(
  json: string,
  now = Date.now(),
): { total: number; problems: PodProblem[] } {
  let parsed: RawPods;
  try {
    parsed = JSON.parse(json || '{}') as RawPods;
  } catch {
    return { total: 0, problems: [] };
  }
  const problems: PodProblem[] = [];
  for (const item of parsed.items ?? []) {
    const namespace = item.metadata?.namespace ?? 'default';
    const pod = item.metadata?.name ?? '?';
    const statuses = item.status?.containerStatuses ?? [];
    const restarts = statuses.reduce((sum, s) => sum + (s.restartCount ?? 0), 0);
    const waiting = statuses
      .map((s) => s.state?.waiting)
      .find((w) => w?.reason && BAD_WAITING.has(w.reason));
    const oom = statuses.some((s) => s.lastState?.terminated?.reason === 'OOMKilled');
    const created = Date.parse(item.metadata?.creationTimestamp ?? '');
    if (waiting)
      problems.push({
        namespace,
        pod,
        reason: waiting.reason!,
        restarts,
        message: waiting.message ?? null,
      });
    else if (oom) problems.push({ namespace, pod, reason: 'OOMKilled', restarts, message: null });
    else if (
      item.status?.phase === 'Pending' &&
      Number.isFinite(created) &&
      now - created > 10 * 60_000
    ) {
      problems.push({
        namespace,
        pod,
        reason: 'Pending',
        restarts,
        message: 'not scheduled or not started for over 10 minutes',
      });
    } else if (item.status?.phase === 'Failed')
      problems.push({ namespace, pod, reason: 'Failed', restarts, message: null });
  }
  return { total: parsed.items?.length ?? 0, problems };
}

export interface ContainersDeps {
  hosts(): readonly Host[];
  runnerFor(hostId: string): SweepRunner | undefined;
}

/**
 * Containers and pods on every server: crash loops, out-of-memory kills,
 * unhealthy containers, ones that stopped with an error, and pods stuck in
 * CrashLoopBackOff, image pull errors or Pending. Keeps the latest snapshot
 * per server for its HUD.
 */
export function createContainersProducer(deps: ContainersDeps): InsightProducer & {
  snapshot(hostId: string): (ContainerSnapshot & { at: number }) | null;
} {
  const snapshots = new Map<string, ContainerSnapshot & { at: number }>();
  /** Restart counts seen last time, to tell a crash loop from an old restart. */
  const previousRestarts = new Map<string, number>();
  return {
    name: 'containers',
    intervalMs: 60_000,
    snapshot: (hostId) => snapshots.get(hostId) ?? null,
    async run(now) {
      const results: ProducerResult[] = [];
      for (const host of deps.hosts()) {
        const runner = deps.runnerFor(host.id);
        if (!runner) continue;
        const snapshot = parseContainers(
          (await runner.exec('sh -s', CONTAINERS_SCRIPT, 30_000).catch(() => ({ stdout: '' })))
            .stdout,
        );
        if (!snapshot) continue;
        snapshots.set(host.id, { ...snapshot, at: now });
        const drafts: ThreatDraft[] = [];
        const add = (
          key: string,
          severity: ThreatSeverity,
          title: string,
          detail: string,
          advice: string,
        ) =>
          drafts.push({
            ...insightDraft({
              key,
              scope: 'containers',
              category: 'container',
              severity,
              title,
              detail,
              advice,
              now,
            }),
          });
        for (const c of snapshot.containers) {
          const before = previousRestarts.get(`${host.id}/${c.name}`);
          previousRestarts.set(`${host.id}/${c.name}`, c.restarts);
          const recentStart = c.startedAt !== null && now - c.startedAt < 10 * 60_000;
          if (
            c.state === 'restarting' ||
            (before !== undefined && c.restarts - before >= 2) ||
            (c.restarts >= 5 && recentStart)
          ) {
            add(
              `container:${c.name}:crashloop`,
              'high',
              `Container ${c.name} keeps restarting`,
              `${c.name} (${c.image}) has restarted ${c.restarts} times${c.exitCode ? `, last exit code ${c.exitCode}` : ''}. It crashes soon after starting.`,
              `Read its last lines: docker logs --tail 50 ${c.name}. A missing setting, a bad image tag or a dependency that is down are the usual causes.`,
            );
          } else if (c.oomKilled) {
            add(
              `container:${c.name}:oom`,
              'high',
              `Container ${c.name} was killed for using too much memory`,
              `The kernel stopped ${c.name} (${c.image}) because it hit its memory limit (OOMKilled).`,
              "Raise its memory limit or find the leak (docker stats, the app's own metrics).",
            );
          } else if (c.health === 'unhealthy') {
            add(
              `container:${c.name}:unhealthy`,
              'medium',
              `Container ${c.name} is unhealthy`,
              `${c.name} (${c.image}) is running but fails its own health check.`,
              `See why: docker inspect --format '{{json .State.Health}}' ${c.name}`,
            );
          } else if (c.state === 'exited' && c.exitCode !== 0 && c.restartPolicy !== 'no') {
            add(
              `container:${c.name}:exited`,
              'medium',
              `Container ${c.name} stopped with an error (exit ${c.exitCode})`,
              `${c.name} (${c.image}) has a restart policy (${c.restartPolicy}) but is stopped with exit code ${c.exitCode}.`,
              `docker logs --tail 50 ${c.name}, then docker start ${c.name} once fixed.`,
            );
          }
        }
        for (const problem of snapshot.pods.problems) {
          const severe = problem.reason !== 'Pending';
          add(
            `pod:${problem.namespace}/${problem.pod}`,
            severe ? 'high' : 'medium',
            `Pod ${problem.namespace}/${problem.pod}: ${problem.reason}`,
            `${problem.pod} in ${problem.namespace} is ${problem.reason}${problem.restarts ? ` after ${problem.restarts} restarts` : ''}${problem.message ? `: ${problem.message}` : ''}.`,
            `kubectl -n ${problem.namespace} describe pod ${problem.pod} and kubectl -n ${problem.namespace} logs ${problem.pod} --previous`,
          );
        }
        const checked = [
          ...(snapshot.docker === 'ok' || snapshot.kubernetes === 'ok' ? ['containers'] : []),
        ];
        results.push({
          targetId: host.id,
          targetName: host.name,
          drafts,
          checkedScopes: checked,
          coverage: [
            {
              name: 'Docker',
              ok: snapshot.docker === 'ok',
              note:
                snapshot.docker === 'ok'
                  ? `${snapshot.containers.length} containers`
                  : snapshot.docker === 'missing'
                    ? 'not installed'
                    : 'installed, but this user may not use it: add it to the "docker" group',
            },
            {
              name: 'Kubernetes',
              ok: snapshot.kubernetes === 'ok',
              note:
                snapshot.kubernetes === 'ok'
                  ? `${snapshot.pods.total} pods`
                  : snapshot.kubernetes === 'missing'
                    ? 'not installed'
                    : "kubectl cannot reach a cluster with this user's config",
            },
          ],
        });
      }
      return results;
    },
  };
}
