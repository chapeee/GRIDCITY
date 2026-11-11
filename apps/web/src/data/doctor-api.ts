import type { Diagnosis, DoctorHint, DoctorReport } from '@app/shared';

/** The Doctor: diagnose a server or resource, apply a proven fix, check everything. */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    problems?: string[];
  };
  if (!response.ok) {
    throw new Error(
      body.problems?.join('\n') ?? body.error ?? `${path} failed (${response.status})`,
    );
  }
  return body;
}

export interface DoctorOverview {
  environment: Diagnosis[];
  troubles: {
    id: string;
    name: string;
    kind: string;
    status: string;
    hint: DoctorHint | null;
    reason: string | null;
  }[];
  demo: boolean;
}

export const fetchDoctorOverview = () => request<DoctorOverview>('/api/doctor');

export const diagnose = (id: string, kind: 'host' | 'resource') =>
  request<DoctorReport>(`/api/doctor/${kind}/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: '{}',
  });

export const applyDoctorFix = (id: string, patch: Record<string, unknown>) =>
  request<{ ok: true }>(`/api/doctor/resource/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
    // undefined means "remove this setting": send it as null so JSON keeps it.
    body: JSON.stringify({
      patch: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null])),
    }),
  });
