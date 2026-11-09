import type { HostInput } from '@app/shared';
import { isMap, isSeq, parseDocument } from 'yaml';
import type { ResolvedSshHost } from './ssh-config';

/** District given to imported hosts; users can regroup them in hosts.yaml. */
export const IMPORTED_DISTRICT = 'ssh config';

export interface ImportPlan {
  hosts: HostInput[];
  skipped: { alias: string; reason: string }[];
}

/** "My Box.local" -> "my-box-local" (valid host id). */
export function aliasToId(alias: string): string {
  return (
    alias
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|-+$/g, '') || 'host'
  );
}

/**
 * Turns resolved ssh config entries into hosts, skipping ones that already
 * exist (same id, or same user@address:port) so importing twice is harmless.
 */
export function planSshConfigImport(
  resolved: readonly ResolvedSshHost[],
  existing: readonly { id: string; address: string; user: string; port: number }[],
  defaultUser: string,
): ImportPlan {
  const ids = new Set(existing.map((host) => host.id));
  const endpoints = new Set(existing.map((host) => `${host.user}@${host.address}:${host.port}`));
  const plan: ImportPlan = { hosts: [], skipped: [] };

  for (const entry of resolved) {
    const user = entry.user ?? defaultUser;
    const port = entry.port ?? 22;
    const endpoint = `${user}@${entry.hostName}:${port}`;
    const id = aliasToId(entry.alias);

    if (ids.has(id)) {
      plan.skipped.push({ alias: entry.alias, reason: `id "${id}" already exists` });
      continue;
    }
    if (endpoints.has(endpoint)) {
      plan.skipped.push({ alias: entry.alias, reason: `${endpoint} is already configured` });
      continue;
    }

    ids.add(id);
    endpoints.add(endpoint);
    plan.hosts.push({
      id,
      name: entry.alias,
      address: entry.hostName,
      port,
      user,
      district: IMPORTED_DISTRICT,
      tags: ['imported'],
      // An explicit IdentityFile is honored as a key path; otherwise the agent.
      auth: entry.identityFile
        ? { method: 'keyFile', path: entry.identityFile }
        : { method: 'agent' },
    });
  }
  return plan;
}

/**
 * Appends hosts to hosts.yaml text, keeping the user's comments and
 * formatting intact.
 */
export function appendHostsToYaml(yamlText: string, hosts: readonly HostInput[]): string {
  const document = parseDocument(yamlText);
  if (!isMap(document.contents))
    document.contents = document.createNode({}) as unknown as typeof document.contents;
  let sequence = document.get('hosts');
  if (!isSeq(sequence)) {
    sequence = document.createNode([]);
    document.set('hosts', sequence);
  }
  // Block style (one "- id: …" entry per host), even if the file had `hosts: []`,
  // so the result stays easy to edit by hand.
  if (isSeq(sequence)) sequence.flow = false;
  for (const host of hosts) {
    const node = document.createNode(host);
    if (isMap(node)) node.flow = false;
    document.addIn(['hosts'], node);
  }
  return document.toString();
}
