import type { ResourceMetric } from '@app/shared';

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

/** Typed once for a test; sent only with that request, never saved. */
export interface OneTimeSecrets {
  password?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface ResourceTestResult {
  ok: boolean;
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

export const addResource = (resource: ResourceDraft) =>
  request<{ ok: true; id: string }>('/api/resources', {
    method: 'POST',
    body: JSON.stringify(resource),
  });

export const editResource = (
  id: string,
  patch: { name?: string; district?: string; tags?: string[] },
) =>
  request<{ ok: true }>(`/api/resources/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const removeResource = (id: string) =>
  request<{ ok: true }>(`/api/resources/${encodeURIComponent(id)}`, { method: 'DELETE' });
