import { HostSchema, type Host, type HostInput } from '@app/shared';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFileLock, writeFileAtomic } from './file-lock';
import { HOSTS_FILE_TEMPLATE, parseHostsYaml } from './hosts-file';
import { appendHostsToYaml } from './import-ssh-config';

export class HostValidationError extends Error {
  override name = 'HostValidationError';
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}

/**
 * Adds one host to hosts.yaml, keeping the user's comments and formatting.
 * Refuses duplicates (same id, or same user@address:port) and never touches
 * a file that is currently invalid. The running server reloads it live.
 */
export async function addHostToFile(hostsFile: string, input: HostInput): Promise<Host> {
  const parsed = HostSchema.safeParse(input);
  if (!parsed.success) {
    throw new HostValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'host'}: ${issue.message}`),
    );
  }
  const host = parsed.data;
  // From the read to the write, one edit at a time (see file-lock.ts).
  return withFileLock(hostsFile, () => addParsedHost(hostsFile, host));
}

async function addParsedHost(hostsFile: string, host: Host): Promise<Host> {
  const text = existsSync(hostsFile) ? await readFile(hostsFile, 'utf8') : HOSTS_FILE_TEMPLATE;
  const current = parseHostsYaml(text);
  if (!current.ok) {
    throw new HostValidationError([`${hostsFile} has errors; fix them first:`, ...current.errors]);
  }

  const problems: string[] = [];
  for (const existing of current.config.hosts) {
    if (existing.id === host.id) problems.push(`id "${host.id}" is already used`);
    if (
      existing.address === host.address &&
      existing.port === host.port &&
      existing.user === host.user
    ) {
      problems.push(
        `${host.user}@${host.address}:${host.port} is already configured as "${existing.id}"`,
      );
    }
  }
  if (problems.length > 0) throw new HostValidationError(problems);

  // Write only what the user chose; defaults stay implicit in the file.
  const entry: HostInput = {
    id: host.id,
    name: host.name,
    address: host.address,
    ...(host.port !== 22 ? { port: host.port } : {}),
    user: host.user,
    district: host.district,
    ...(host.tags.length > 0 ? { tags: host.tags } : {}),
    ...(host.auth.method !== 'agent' ? { auth: host.auth } : {}),
    ...(host.jump
      ? {
          jump: {
            address: host.jump.address,
            ...(host.jump.port !== 22 ? { port: host.jump.port } : {}),
            user: host.jump.user,
            ...(host.jump.auth.method !== 'agent' ? { auth: host.jump.auth } : {}),
          },
        }
      : {}),
  };
  await mkdir(dirname(hostsFile), { recursive: true });
  await writeFileAtomic(hostsFile, appendHostsToYaml(text, [entry]));
  return host;
}
