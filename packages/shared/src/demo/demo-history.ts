import type { HistoryIncident, HistoryPoint, HistoryResponse } from '../history';
import { createSeededRandom } from './seeded-random';

/**
 * Generated history for the in-browser demo: a daily load cycle and a few
 * incidents per target, deterministic per id. Only ever shown with the
 * DEMO DATA badge.
 */
export function createDemoHistory(
  targetIds: readonly string[],
  targetId: string | null,
  now: number,
  days: number,
): HistoryResponse {
  const until = now;
  const since = now - days * 86_400_000;
  const bucketMs = Math.max(60_000, Math.round((until - since) / 600 / 60_000) * 60_000);
  const ids = targetId === null ? targetIds : [targetId];
  const incidents = ids.flatMap((id) => demoIncidents(id, since, until));
  const points: HistoryPoint[] = [];
  if (targetId !== null) {
    const random = createSeededRandom(hash(targetId));
    const base = 20 + random.next() * 30;
    for (let at = Math.ceil(since / bucketMs) * bucketMs; at <= until; at += bucketMs) {
      const hour = new Date(at).getHours() + new Date(at).getMinutes() / 60;
      const daily = Math.sin(((hour - 8) / 24) * Math.PI * 2) * 0.5 + 0.5;
      const inIncident = incidents.find(
        (i) => i.status === 'degraded' && at >= i.startedAt && at <= (i.endedAt ?? until),
      );
      const offline = incidents.some(
        (i) => i.status === 'offline' && at >= i.startedAt && at <= (i.endedAt ?? until),
      );
      if (offline) {
        points.push({
          at,
          cpuPercent: null,
          memoryPercent: null,
          maxDiskPercent: null,
          networkBytesPerSec: null,
          loadOne: null,
        });
        continue;
      }
      const cpu = Math.min(
        100,
        Math.max(0, base + daily * 35 + random.noise(6) + (inIncident ? 45 : 0)),
      );
      points.push({
        at,
        cpuPercent: cpu,
        memoryPercent: Math.min(100, 45 + daily * 15 + random.noise(3)),
        maxDiskPercent: 52 + ((at - since) / (until - since)) * 6,
        networkBytesPerSec: Math.max(0, 2e6 * (0.3 + daily) + random.noise(4e5)),
        loadOne: (cpu / 100) * 4,
      });
    }
  }
  return {
    targetId,
    since,
    until,
    retentionDays: 7,
    bucketMs,
    points,
    incidents: incidents.sort((a, b) => a.startedAt - b.startedAt),
  };
}

function demoIncidents(id: string, since: number, until: number): HistoryIncident[] {
  const random = createSeededRandom(hash(id) + 17);
  const count = Math.floor(random.next() * 4);
  const incidents: HistoryIncident[] = [];
  const day = 86_400_000;
  for (let i = 0; i < count; i++) {
    const startedAt = until - Math.floor(random.next() * 7 * day);
    const offline = random.next() < 0.25;
    const length = offline
      ? 2 * 60_000 + random.next() * 20 * 60_000
      : 10 * 60_000 + random.next() * 90 * 60_000;
    if (startedAt < since) continue;
    incidents.push({
      targetId: id,
      status: offline ? 'offline' : 'degraded',
      reason: offline
        ? 'heartbeat lost'
        : random.next() < 0.6
          ? `CPU ${Math.round(92 + random.next() * 7)}% for 3 polls`
          : `memory ${Math.round(91 + random.next() * 7)}%`,
      startedAt,
      endedAt: Math.min(until, Math.round(startedAt + length)),
    });
  }
  return incidents;
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}
