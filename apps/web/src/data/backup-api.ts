import type {
  BackupDashboard,
  BackupEvent,
  BackupManifest,
  BackupNotification,
  BackupSourceKind,
  DestinationInput,
  DestinationView,
  DiscoveryResult,
  JobInput,
  JobView,
  LogLine,
  OperationProgress,
  RestoreInput,
  RestoreSummary,
  RunSummary,
  SourceCapabilities,
  SourceConfig,
} from '@app/shared';
import { create } from 'zustand';

/** The Backup Center's calls to /api/backup (same-origin cookie, Origin checked on writes). */
async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`/api/backup${path}`, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body;
}

export interface BackupOptions {
  demo: boolean;
  hosts: { id: string; name: string; connected: boolean }[];
  resources: {
    id: string;
    name: string;
    kind: string;
    buckets: string[] | null;
    database: string | null;
  }[];
  capabilities: Record<BackupSourceKind, SourceCapabilities>;
  labels: Record<BackupSourceKind, string>;
  zstd: boolean;
  defaultLocalDir: string;
  platform: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; type: 'dir' | 'file'; size?: number; modifiedAt?: number }[];
  freeBytes?: number | null;
}

export interface RestorePlan {
  label: string;
  chain: {
    id: string;
    type: string;
    startedAt: number;
    storedBytes: number | null;
    fileName: string | null;
  }[];
  problems: string[];
  encrypted: boolean;
  sameAsOriginal: boolean;
}

export type JobWithText = JobView & { scheduleText: string | null };

export const backupApi = {
  options: () => call<BackupOptions>('/options'),
  overview: () => call<BackupDashboard>('/overview'),
  destinations: () => call<DestinationView[]>('/destinations'),
  saveDestination: (id: string | null, input: DestinationInput) =>
    call<{ id: string }>(id ? `/destinations/${id}` : '/destinations', {
      method: id ? 'PUT' : 'POST',
      body: input,
    }),
  removeDestination: (id: string) =>
    call<{ ok: true }>(`/destinations/${id}`, { method: 'DELETE' }),
  testDestination: (input: DestinationInput) =>
    call<{ ok: boolean; message: string }>('/destinations/test', { body: input }),
  browse: (query: {
    kind: 'local' | 's3' | 'sftp';
    path: string;
    resourceId?: string;
    hostId?: string;
  }) => call<BrowseResult>('/browse', { body: query }),
  mkdir: (query: {
    kind: 'local' | 's3' | 'sftp';
    path: string;
    resourceId?: string;
    hostId?: string;
    name: string;
  }) => call<{ path: string }>('/browse/mkdir', { body: query }),
  jobs: () => call<JobWithText[]>('/jobs'),
  saveJob: (id: string | null, input: JobInput) =>
    call<JobView>(id ? `/jobs/${id}` : '/jobs', { method: id ? 'PUT' : 'POST', body: input }),
  removeJob: (id: string) => call<{ ok: true }>(`/jobs/${id}`, { method: 'DELETE' }),
  runJob: (id: string, type?: 'full' | 'incremental' | 'differential') =>
    call<{ runId: string }>(`/jobs/${id}/run`, { body: type ? { type } : {} }),
  testSource: (source: SourceConfig) =>
    call<{ ok: boolean; message: string }>('/sources/test', { body: { source } }),
  runs: (query: { jobId?: string; status?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== '') params.set(k, String(v));
    return call<RunSummary[]>(`/runs?${params.toString()}`);
  },
  run: (id: string) =>
    call<{ run: RunSummary; manifest: BackupManifest | null; logs: LogLine[] }>(`/runs/${id}`),
  deleteRun: (id: string) => call<{ failed: string[] }>(`/runs/${id}`, { method: 'DELETE' }),
  verifyRun: (id: string, passphrase?: string) =>
    call<{ operationId: string }>(`/runs/${id}/verify`, { body: passphrase ? { passphrase } : {} }),
  logs: (ownerId: string) => call<LogLine[]>(`/logs/${ownerId}`),
  discover: () => call<DiscoveryResult>('/discover'),
  restorePlan: (runId: string, target: Partial<SourceConfig>) =>
    call<RestorePlan>('/restore/plan', { body: { runId, target } }),
  restore: (input: Partial<RestoreInput> & { runId: string; confirm: string }) =>
    call<{ restoreId: string }>('/restore', { body: input }),
  restores: () => call<RestoreSummary[]>('/restores'),
  cancel: (operationId: string) =>
    call<{ ok: boolean }>(`/operations/${operationId}/cancel`, { body: {} }),
  notifications: () => call<BackupNotification[]>('/notifications'),
  markRead: (id: number | 'all') =>
    call<{ ok: true; unread: number }>('/notifications/read', { body: { id } }),
};

/**
 * Live state from /api/backup/events: running operations, their log lines,
 * and a version counter that tells views to reload when something changed.
 */
interface BackupLive {
  connected: boolean;
  operations: Record<string, OperationProgress>;
  /** Recently finished operations (kept for a short while so the result is visible). */
  finished: OperationProgress[];
  logs: Record<string, LogLine[]>;
  version: number;
  unread: number;
  lastNotification: BackupNotification | null;
  setUnread(n: number): void;
}

export const useBackupLive = create<BackupLive>()((set) => ({
  connected: false,
  operations: {},
  finished: [],
  logs: {},
  version: 0,
  unread: 0,
  lastNotification: null,
  setUnread: (n) => set({ unread: n }),
}));

let source: EventSource | null = null;
let users = 0;

/** Opens the event stream while at least one view needs it. */
export function connectBackupEvents(): () => void {
  users++;
  if (!source) {
    source = new EventSource('/api/backup/events', { withCredentials: true });
    source.onopen = () => useBackupLive.setState({ connected: true });
    source.onerror = () => useBackupLive.setState({ connected: false });
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as BackupEvent;
      useBackupLive.setState((state) => {
        switch (event.type) {
          case 'progress': {
            const op = event.operation;
            if (op.finishedAt) {
              const rest = Object.fromEntries(
                Object.entries(state.operations).filter(([id]) => id !== op.id),
              );
              return {
                operations: rest,
                finished: [op, ...state.finished.filter((f) => f.id !== op.id)].slice(0, 10),
                version: state.version + 1,
              };
            }
            return { operations: { ...state.operations, [op.id]: op } };
          }
          case 'log': {
            const lines = [...(state.logs[event.operationId] ?? []), event.line].slice(-300);
            return { logs: { ...state.logs, [event.operationId]: lines } };
          }
          case 'notification':
            return {
              lastNotification: event.notification,
              unread: state.unread + 1,
              version: state.version + 1,
            };
          case 'changed':
            return { version: state.version + 1 };
        }
      });
    };
  }
  return () => {
    users--;
    if (users <= 0 && source) {
      source.close();
      source = null;
      users = 0;
      useBackupLive.setState({ connected: false });
    }
  };
}
