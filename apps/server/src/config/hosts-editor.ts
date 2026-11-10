import {
  HostThresholdOverridesSchema,
  ThresholdsPatchSchema,
  type Host,
  type StatusThresholds,
} from '@app/shared';
import { readFile, writeFile } from 'node:fs/promises';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import { z } from 'zod';
import { parseHostsYaml, type HostsConfig } from './hosts-file';
import { HostValidationError } from './hosts-writer';

/** File-wide thresholds editable in Settings. */
export const FileThresholdsSchema = ThresholdsPatchSchema;

/** Fields the edit dialog may change. The id never changes (layout and history follow it). */
export const HostPatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  district: z.string().trim().min(1).max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  /** Per-host overrides of the warning (degraded) thresholds; null removes them. */
  thresholds: HostThresholdOverridesSchema.nullable().optional(),
});
export type HostPatch = z.infer<typeof HostPatchSchema>;

/**
 * Edits one host in hosts.yaml in place, keeping comments and formatting.
 * Refuses to touch a file that is currently invalid, and validates the
 * result before writing. The running server reloads it live.
 */
export async function editHostInFile(
  hostsFile: string,
  id: string,
  patch: HostPatch,
): Promise<Host> {
  const valid = HostPatchSchema.safeParse(patch);
  if (!valid.success) throw new HostValidationError(valid.error.issues.map(formatIssue));
  return writeEdited(hostsFile, (document) => {
    const item = findHost(document, id);
    const { name, district, tags, thresholds } = valid.data;
    if (name !== undefined) item.set('name', name);
    if (district !== undefined) item.set('district', district);
    if (tags !== undefined) {
      if (tags.length > 0) item.set('tags', tags);
      else item.delete('tags');
    }
    if (thresholds === null || (thresholds && Object.keys(thresholds).length === 0)) {
      item.delete('thresholds');
    } else if (thresholds) {
      item.set('thresholds', thresholds);
    }
  }).then((config) => config.hosts.find((host) => host.id === id)!);
}

/** Removes one host from hosts.yaml (its history stays until it ages out). */
export async function removeHostFromFile(hostsFile: string, id: string): Promise<void> {
  await writeEdited(hostsFile, (document) => {
    const hosts = document.get('hosts');
    if (!isSeq(hosts)) throw new HostValidationError([`no host "${id}" in hosts.yaml`]);
    const index = hosts.items.findIndex((item) => isMap(item) && item.get('id') === id);
    if (index < 0) throw new HostValidationError([`no host "${id}" in hosts.yaml`]);
    hosts.items.splice(index, 1);
  });
}

/** Writes the file-wide thresholds (Settings). Values equal to the defaults are still written. */
export async function setFileThresholds(
  hostsFile: string,
  thresholds: Partial<StatusThresholds>,
): Promise<StatusThresholds> {
  const valid = FileThresholdsSchema.safeParse(thresholds);
  if (!valid.success) throw new HostValidationError(valid.error.issues.map(formatIssue));
  const config = await writeEdited(hostsFile, (document) => {
    const current = document.get('thresholds');
    const merged = { ...(isMap(current) ? (current.toJSON() as object) : {}), ...valid.data };
    document.set('thresholds', merged);
  });
  return config.thresholds;
}

async function writeEdited(
  hostsFile: string,
  change: (document: Document) => void,
): Promise<HostsConfig> {
  const text = await readFile(hostsFile, 'utf8');
  const before = parseHostsYaml(text);
  if (!before.ok) {
    throw new HostValidationError([`${hostsFile} has errors; fix them first:`, ...before.errors]);
  }
  const document = parseDocument(text);
  change(document);
  const next = document.toString();
  const after = parseHostsYaml(next);
  if (!after.ok) throw new HostValidationError(after.errors);
  await writeFile(hostsFile, next, 'utf8');
  return after.config;
}

function findHost(document: Document, id: string): YAMLMap {
  const hosts = document.get('hosts');
  const item = isSeq(hosts)
    ? hosts.items.find((entry) => isMap(entry) && entry.get('id') === id)
    : undefined;
  if (!item || !isMap(item)) throw new HostValidationError([`no host "${id}" in hosts.yaml`]);
  return item as YAMLMap;
}

function formatIssue(issue: z.core.$ZodIssue): string {
  return `${issue.path.join('.') || 'value'}: ${issue.message}`;
}
