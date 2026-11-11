import type { DoctorReport, ResourceMetric } from '@app/shared';

/** "Connect a database or bucket": calls to the local server (real mode only). */

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

/** A resources.yaml entry as the dialog builds it. Never contains a secret. */
export type ResourceDraft = Record<string, unknown> & { kind: string; id: string };

/**
 * Credentials typed in the dialog. Test uses them once; Add and Edit save them
 * encrypted on the server (only their ids go into resources.yaml).
 */
export interface OneTimeSecrets {
  password?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface ResourceTestResult {
  ok: boolean;
  /** Why it failed and which proven change fixes it (only when not ok). */
  doctor?: DoctorReport;
  found: {
    name: string;
    engine: string;
    ok: boolean;
    error: string | null;
    metrics: ResourceMetric[];
  }[];
  error: string | null;
}

export const testResource = (resource: ResourceDraft, secrets: OneTimeSecrets) =>
  request<ResourceTestResult>('/api/resources/test', {
    method: 'POST',
    body: JSON.stringify({ resource, ...secrets }),
  });

export const addResource = (resource: ResourceDraft, secrets: OneTimeSecrets = {}) =>
  request<{ ok: true; id: string }>('/api/resources', {
    method: 'POST',
    body: JSON.stringify({ resource, secrets: nonEmpty(secrets) }),
  });

/** Drops empty fields, so an untouched field never replaces a saved value. */
function nonEmpty(secrets: OneTimeSecrets): OneTimeSecrets {
  return Object.fromEntries(
    Object.entries(secrets).filter(([, value]) => typeof value === 'string' && value !== ''),
  );
}

/** Which credentials an entry has saved in the app (never the values themselves). */
export const fetchCredentials = (id: string) =>
  request<{ password: boolean; accessKey: boolean }>(
    `/api/resources/${encodeURIComponent(id)}/credentials`,
  );

export const editResource = (
  id: string,
  patch: { name?: string; district?: string; tags?: string[] },
  secrets: OneTimeSecrets = {},
) =>
  request<{ ok: true }>(`/api/resources/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, secrets: nonEmpty(secrets) }),
  });

export const removeResource = (id: string) =>
  request<{ ok: true }>(`/api/resources/${encodeURIComponent(id)}`, { method: 'DELETE' });
