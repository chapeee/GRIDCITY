import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import { z } from 'zod';
import { withFileLock, writeFileAtomic } from './file-lock';
import {
  findInlineSecret,
  parseResourcesYaml,
  RESOURCES_FILE_TEMPLATE,
  ResourceConfigSchema,
  type ResourceConfig,
  type ResourcesConfig,
} from './resources-file';

export class ResourceValidationError extends Error {
  override name = 'ResourceValidationError';
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}

/** What Edit may change on a resources.yaml entry. Connection details are re-added instead. */
export const ResourcePatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  district: z.string().trim().min(1).max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
export type ResourcePatch = z.infer<typeof ResourcePatchSchema>;

/**
 * Validates a draft from the "Connect a database or bucket" dialog. Secrets
 * are refused here too: the file only ever names where a password lives.
 */
export function parseResourceDraft(input: unknown): ResourceConfig {
  const secret = findInlineSecret(input);
  if (secret) throw new ResourceValidationError([secret]);
  const parsed = ResourceConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new ResourceValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'resource'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/**
 * Appends one entry to resources.yaml, keeping the user's comments. Only the
 * fields the user set are written (defaults stay implicit). Refuses duplicate
 * ids (also against host ids) and never touches a file that is invalid.
 */
export async function addResourceToFile(
  file: string,
  input: unknown,
  takenIds: ReadonlySet<string> = new Set(),
): Promise<ResourceConfig> {
  const resource = parseResourceDraft(input);
  if (takenIds.has(resource.id)) {
    throw new ResourceValidationError([`id "${resource.id}" is already used by a server`]);
  }
  return writeEdited(file, (document, current) => {
    if (current.resources.some((existing) => existing.id === resource.id)) {
      throw new ResourceValidationError([`id "${resource.id}" is already used`]);
    }
    let list = document.get('resources');
    if (!isSeq(list)) {
      document.set('resources', []);
      list = document.get('resources');
    }
    if (isSeq(list)) list.flow = false;
    document.addIn(
      ['resources'],
      document.createNode(minimalEntry(input as Record<string, unknown>, resource)),
    );
  }).then(() => resource);
}

export async function editResourceInFile(
  file: string,
  id: string,
  patch: ResourcePatch,
): Promise<void> {
  const valid = ResourcePatchSchema.safeParse(patch);
  if (!valid.success) {
    throw new ResourceValidationError(
      valid.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  await writeEdited(file, (document) => {
    const item = findEntry(document, id);
    const { name, district, tags } = valid.data;
    if (name !== undefined) item.set('name', name);
    if (district !== undefined) item.set('district', district);
    if (tags !== undefined) {
      if (tags.length > 0) item.set('tags', tags);
      else item.delete('tags');
    }
  });
}

/** Keys that say where credentials come from; replaced together when new ones are typed. */
const CREDENTIAL_KEYS = [
  'passwordSecret',
  'passwordEnv',
  'passwordFile',
  'accessKeyIdSecret',
  'secretAccessKeySecret',
  'accessKeyIdEnv',
  'secretAccessKeyEnv',
  'profile',
] as const;

/**
 * Rewrites where an entry's credentials come from (Edit → new password or
 * keys). `change` gets the parsed entry and returns it with new references;
 * only credential keys are touched, comments and everything else stay.
 * Returns false when nothing changed.
 */
export async function updateSecretRefsInFile(
  file: string,
  id: string,
  change: (config: ResourceConfig) => ResourceConfig,
): Promise<boolean> {
  let changed = false;
  await writeEdited(file, (document, current) => {
    const config = current.resources.find((entry) => entry.id === id);
    if (!config) throw new ResourceValidationError([`no resource "${id}" in resources.yaml`]);
    const next = change(config) as Record<string, unknown>;
    const item = findEntry(document, id);
    for (const key of CREDENTIAL_KEYS) {
      const before = (config as Record<string, unknown>)[key];
      const after = next[key];
      if (before === after) continue;
      changed = true;
      if (after === undefined) item.delete(key);
      else item.set(key, after);
    }
  });
  return changed;
}

/**
 * Sets (or, for `undefined`, removes) a few settings of one entry, keeping
 * comments. Only `allowed` keys are touched: the Doctor applies proven fixes
 * through this, never anything else.
 */
export async function patchResourceInFile(
  file: string,
  id: string,
  patch: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Promise<void> {
  const refused = Object.keys(patch).filter((key) => !allowed.has(key));
  if (refused.length > 0) {
    throw new ResourceValidationError([
      `these settings cannot be changed this way: ${refused.join(', ')}`,
    ]);
  }
  await writeEdited(file, (document) => {
    const item = findEntry(document, id);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) item.delete(key);
      else item.set(key, value);
    }
  });
}

export async function removeResourceFromFile(file: string, id: string): Promise<void> {
  await writeEdited(file, (document) => {
    const list = document.get('resources');
    const index = isSeq(list)
      ? list.items.findIndex((item) => isMap(item) && item.get('id') === id)
      : -1;
    if (!isSeq(list) || index < 0)
      throw new ResourceValidationError([`no resource "${id}" in resources.yaml`]);
    list.items.splice(index, 1);
  });
}

/** One edit at a time per file, from the read to the write (see file-lock.ts). */
function writeEdited(
  file: string,
  change: (document: Document, current: ResourcesConfig) => void,
): Promise<ResourcesConfig> {
  return withFileLock(file, () => writeEditedNow(file, change));
}

async function writeEditedNow(
  file: string,
  change: (document: Document, current: ResourcesConfig) => void,
): Promise<ResourcesConfig> {
  const text = existsSync(file) ? await readFile(file, 'utf8') : RESOURCES_FILE_TEMPLATE;
  const before = parseResourcesYaml(text);
  if (!before.ok) {
    throw new ResourceValidationError([`${file} has errors; fix them first:`, ...before.errors]);
  }
  const document = parseDocument(text);
  change(document, before.config);
  const next = document.toString();
  const after = parseResourcesYaml(next);
  if (!after.ok) throw new ResourceValidationError(after.errors);
  // Entries that were already broken (and skipped) stay the user's to fix;
  // refuse only a change that breaks something new.
  const known = new Set(before.skipped.map(withoutIndex));
  const added = after.skipped.filter((problem) => !known.has(withoutIndex(problem)));
  if (added.length > 0) throw new ResourceValidationError(added);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, next);
  return after.config;
}

/** "resources.3 \"cache\" (not loaded): …" without the position, which shifts on edits. */
function withoutIndex(problem: string): string {
  return problem.replace(/^resources\.\d+\s*/, '');
}

function findEntry(document: Document, id: string): YAMLMap {
  const list = document.get('resources');
  const item = isSeq(list)
    ? list.items.find((entry) => isMap(entry) && entry.get('id') === id)
    : undefined;
  if (!item || !isMap(item))
    throw new ResourceValidationError([`no resource "${id}" in resources.yaml`]);
  return item as YAMLMap;
}

/** The entry as written: kind and id first, then only the keys the user actually gave. */
function minimalEntry(
  input: Record<string, unknown>,
  resource: ResourceConfig,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { kind: resource.kind, id: resource.id };
  for (const [key, value] of Object.entries(resource)) {
    if (key === 'kind' || key === 'id') continue;
    const given = input[key];
    if (given === undefined || given === null || given === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    entry[key] = value;
  }
  return entry;
}
