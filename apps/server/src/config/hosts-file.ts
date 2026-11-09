import { HostSchema, StatusThresholdsSchema, type Host, type StatusThresholds } from '@app/shared';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

/** Schema of hosts.yaml. Thresholds are optional; unset values use the defaults. */
export const HostsFileSchema = z
  .object({
    thresholds: StatusThresholdsSchema.prefault({}),
    hosts: z.array(HostSchema).prefault([]),
  })
  .superRefine((file, context) => {
    const seen = new Map<string, number>();
    file.hosts.forEach((host, index) => {
      const first = seen.get(host.id);
      if (first !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['hosts', index, 'id'],
          message: `duplicate id "${host.id}" (also used by hosts[${first}])`,
        });
      }
      seen.set(host.id, index);
    });
  });

export interface HostsConfig {
  hosts: Host[];
  thresholds: StatusThresholds;
}

export type HostsFileResult = { ok: true; config: HostsConfig } | { ok: false; errors: string[] };

/** Written on first start so users have a commented example to edit. */
export const HOSTS_FILE_TEMPLATE = `# Hosts shown in the city. A running server picks up changes automatically.
# Import from ~/.ssh/config with: npm run import-ssh-config
#
# hosts:
#   - id: web-01                 # stable id: a-z, 0-9, "-" and "_"
#     name: web-01               # label shown on the tower
#     address: 203.0.113.10      # hostname or IP
#     port: 22                   # optional, default 22
#     user: ops
#     district: Hetzner          # optional grouping; one district per value
#     tags: [web]                # optional
#     auth:                      # optional, default: system ssh-agent
#       method: agent            # or: keyFile
#       # path: ~/.ssh/id_ed25519  (keyFile only; the key itself is never stored)
#
# thresholds:                    # optional; defaults shown
#   pollIntervalMs: 2000
#   staleAfterPolls: 3
#   cpuDegradedPercent: 90
#   cpuDegradedPolls: 3
#   memoryDegradedPercent: 90
#   diskDegradedPercent: 90

hosts: []
`;

/** Parses and validates hosts.yaml text, collecting every problem with its location. */
export function parseHostsYaml(text: string): HostsFileResult {
  const document = parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    return { ok: false, errors: document.errors.map((error) => `YAML: ${error.message}`) };
  }
  const result = HostsFileSchema.safeParse(document.toJS() ?? {});
  if (!result.success) {
    return { ok: false, errors: result.error.issues.map(formatIssue) };
  }
  return { ok: true, config: result.data };
}

/** Reads hosts.yaml, creating the commented template on first run. */
export async function loadHostsFile(filePath: string): Promise<HostsFileResult> {
  if (!existsSync(filePath)) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, HOSTS_FILE_TEMPLATE, { encoding: 'utf8', flag: 'wx' }).catch(
      () => {},
    );
  }
  return parseHostsYaml(await readFile(filePath, 'utf8'));
}

/** "hosts[2].port: Too big: expected number to be <=65535" */
function formatIssue(issue: z.core.$ZodIssue): string {
  const location = issue.path
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : `${index === 0 ? '' : '.'}${String(segment)}`,
    )
    .join('');
  return `${location || '(root)'}: ${issue.message}`;
}
