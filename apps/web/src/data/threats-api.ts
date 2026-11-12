import type { ThreatFinding, ThreatsView } from '@app/shared';
import { createDemoThreatsView } from './demo-threats';
import { useServerLink } from './server-link';

/** Attack and exposure findings: the server's /api/threats routes. */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init?.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${path} failed (${response.status})`);
  return body;
}

export interface FixOption {
  id: string;
  label: string;
  description: string;
  preview: string;
}

const inBrowserDemo = () => useServerLink.getState().source !== 'server';

export const threatsApi = {
  load: () =>
    inBrowserDemo()
      ? Promise.resolve(createDemoThreatsView())
      : request<ThreatsView>('/api/threats'),
  acknowledge: (id: string) =>
    request<ThreatsView>(`/api/threats/${encodeURIComponent(id)}/acknowledge`, {
      method: 'POST',
      body: '{}',
    }),
  fixes: (id: string) =>
    request<{ fixes: FixOption[] }>(`/api/threats/${encodeURIComponent(id)}/fixes`),
  fix: (id: string, fixId: string) =>
    request<{ outcome: { ok: boolean; message: string; output: string }; view: ThreatsView }>(
      `/api/threats/${encodeURIComponent(id)}/fix`,
      { method: 'POST', body: JSON.stringify({ fixId }) },
    ),
  checkNow: () => request<ThreatsView>('/api/threats/check', { method: 'POST', body: '{}' }),
  timeline: (since: number, until: number) =>
    inBrowserDemo()
      ? Promise.resolve({ findings: [] as ThreatFinding[] })
      : request<{ findings: ThreatFinding[] }>(
          `/api/threats/timeline?since=${Math.floor(since)}&until=${Math.floor(until)}`,
        ),
};

export interface BackupExpectation {
  id: string;
  name: string;
  targetId: string;
  kind: 'file' | 's3';
  path: string;
  maxAgeHours: number;
  minBytes: number;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    problems?: string[];
  };
  if (!response.ok)
    throw new Error(
      parsed.problems?.join(' ') ?? parsed.error ?? `${path} failed (${response.status})`,
    );
  return parsed;
}

export const backupsApi = {
  list: () =>
    inBrowserDemo()
      ? Promise.resolve({ backups: [] as BackupExpectation[] })
      : send<{ backups: BackupExpectation[] }>('/api/backups', 'GET'),
  save: (input: Omit<BackupExpectation, 'id'> & { id?: string }) =>
    send<{ backup: BackupExpectation }>('/api/backups', 'POST', input),
  remove: (id: string) => send<ThreatsView>(`/api/backups/${encodeURIComponent(id)}`, 'DELETE'),
};
