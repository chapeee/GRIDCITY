import { describe, expect, it } from 'vitest';
import { createContainersProducer, parseContainers, parsePods } from './containers';

const NOW = Date.parse('2026-11-12T10:00:00Z');
const host = {
  id: 'web',
  name: 'web-1',
  address: 'h',
  port: 22,
  user: 'u',
  district: 'D',
  tags: [],
  auth: { method: 'agent' as const },
};

const output = (restarts: number) =>
  [
    '@@docker ok',
    '@@inspect',
    `/api\tshop/api:1.4\trestarting\t${restarts}\t1\tfalse\t\talways\t2026-11-12T09:59:30Z`,
    '/worker\tshop/worker:1.4\trunning\t0\t0\ttrue\t\talways\t2026-11-12T08:00:00Z',
    '/web\tnginx:1.27\trunning\t0\t0\tfalse\tunhealthy\talways\t2026-11-12T08:00:00Z',
    '/job\talpine:3.20\texited\t0\t2\tfalse\t\ton-failure\t2026-11-12T07:00:00Z',
    '/once\talpine:3.20\texited\t0\t1\tfalse\t\tno\t2026-11-12T07:00:00Z',
    '@@stats',
    'web\t0.50%\t20MiB / 1GiB',
    '@@kubectl missing',
    '@@end',
  ].join('\n');

describe('containers', () => {
  it('reads docker inspect and stats', () => {
    const snapshot = parseContainers(output(7))!;
    expect(snapshot.docker).toBe('ok');
    expect(snapshot.containers.find((c) => c.name === 'web')).toMatchObject({
      health: 'unhealthy',
      cpuPercent: 0.5,
      memory: '20MiB / 1GiB',
    });
    expect(snapshot.containers.find((c) => c.name === 'worker')).toMatchObject({ oomKilled: true });
    expect(parseContainers('@@docker denied\n@@kubectl missing\n@@end')!.docker).toBe('denied');
  });

  it('flags crash loops, OOM kills, unhealthy and failed containers, not a one-off job that exited', async () => {
    const producer = createContainersProducer({
      hosts: () => [host],
      runnerFor: () => ({ exec: async () => ({ stdout: output(7) }) }),
    });
    const [result] = await producer.run(NOW);
    expect(result!.drafts.map((d) => `${d.key}=${d.severity}`)).toEqual([
      'container:api:crashloop=high',
      'container:worker:oom=high',
      'container:web:unhealthy=medium',
      'container:job:exited=medium',
    ]);
    expect(result!.coverage!.map((c) => `${c.name}:${c.ok}`)).toEqual([
      'Docker:true',
      'Kubernetes:false',
    ]);
    expect(producer.snapshot('web')!.containers).toHaveLength(5);
  });

  it('finds pods in trouble', () => {
    const pods = parsePods(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'api-1', namespace: 'shop' },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  restartCount: 12,
                  state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } },
                },
              ],
            },
          },
          {
            metadata: { name: 'img-1', namespace: 'shop' },
            status: {
              phase: 'Pending',
              containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }],
            },
          },
          {
            metadata: { name: 'big-1', namespace: 'data' },
            status: {
              phase: 'Running',
              containerStatuses: [
                { restartCount: 3, lastState: { terminated: { reason: 'OOMKilled' } } },
              ],
            },
          },
          {
            metadata: {
              name: 'wait-1',
              namespace: 'data',
              creationTimestamp: '2026-11-12T09:00:00Z',
            },
            status: { phase: 'Pending' },
          },
          {
            metadata: { name: 'ok-1', namespace: 'shop' },
            status: { phase: 'Running', containerStatuses: [{ restartCount: 0 }] },
          },
        ],
      }),
      NOW,
    );
    expect(pods.total).toBe(5);
    expect(pods.problems.map((p) => `${p.pod}:${p.reason}`)).toEqual([
      'api-1:CrashLoopBackOff',
      'img-1:ImagePullBackOff',
      'big-1:OOMKilled',
      'wait-1:Pending',
    ]);
  });
});
