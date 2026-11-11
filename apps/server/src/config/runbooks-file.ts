import { BUILTIN_RUNBOOKS, RunbookSchema, type Runbook } from '@app/shared';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

/**
 * runbooks.yaml: your own saved commands, merged with the built-in read-only
 * diagnostics. An entry with a built-in id replaces that built-in, so you
 * can tune "Top processes" without losing it. Nothing in here is secret and
 * nothing runs by itself.
 */
const RunbookEntrySchema = RunbookSchema.omit({ builtin: true });

export const RunbooksFileSchema = z
  .object({ runbooks: z.array(RunbookEntrySchema).prefault([]) })
  .superRefine((file, context) => {
    const seen = new Map<string, number>();
    file.runbooks.forEach((runbook, index) => {
      const first = seen.get(runbook.id);
      if (first !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['runbooks', index, 'id'],
          message: `duplicate id "${runbook.id}" (also runbooks[${first}])`,
        });
      }
      seen.set(runbook.id, index);
    });
  });

export type RunbooksFileResult =
  { ok: true; runbooks: Runbook[] } | { ok: false; errors: string[] };

export const RUNBOOKS_FILE_TEMPLATE = `# Runbooks: commands you run often, saved once, run on one server or many
# from the app (Ctrl+K → "Run a runbook"). You pick the servers and confirm
# every run; results and exit codes land in the audit log. A few read-only
# diagnostics ship built in; an entry with the same id replaces one.
#
# runbooks:
#   - id: restart-nginx
#     name: Restart nginx
#     description: Reload the config, or restart if the reload fails.
#     command: sudo -n systemctl reload nginx || sudo -n systemctl restart nginx
#     match:                      # optional; every server when omitted
#       tags: [web]
#       districts: [Hetzner]
#       hosts: [web-01]
#     timeoutSeconds: 60
#   - id: docker-prune
#     name: Prune unused docker data
#     command: docker system prune -f
#     match: { tags: [docker] }

runbooks: []
`;

export function parseRunbooksYaml(text: string): RunbooksFileResult {
  const document = parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    return { ok: false, errors: document.errors.map((error) => `YAML: ${error.message}`) };
  }
  const result = RunbooksFileSchema.safeParse(document.toJS() ?? {});
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, runbooks: mergeRunbooks(result.data.runbooks) };
}

/** Built-ins first (replaced in place by same-id entries), then the user's own. */
export function mergeRunbooks(own: readonly Omit<Runbook, 'builtin'>[]): Runbook[] {
  const ownById = new Map(own.map((runbook) => [runbook.id, runbook]));
  const merged: Runbook[] = BUILTIN_RUNBOOKS.map((builtin) => {
    const replacement = ownById.get(builtin.id);
    if (!replacement) return builtin;
    ownById.delete(builtin.id);
    return { ...replacement, builtin: false };
  });
  for (const runbook of ownById.values()) merged.push({ ...runbook, builtin: false });
  return merged;
}

/** Reads runbooks.yaml, creating the commented template on first run. */
export async function loadRunbooksFile(filePath: string): Promise<RunbooksFileResult> {
  if (!existsSync(filePath)) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, RUNBOOKS_FILE_TEMPLATE, { encoding: 'utf8', flag: 'wx' }).catch(
      () => {},
    );
  }
  return parseRunbooksYaml(await readFile(filePath, 'utf8'));
}
