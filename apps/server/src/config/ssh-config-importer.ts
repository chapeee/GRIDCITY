import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFileLock, writeFileAtomic } from './file-lock';
import { HOSTS_FILE_TEMPLATE, parseHostsYaml } from './hosts-file';
import { appendHostsToYaml, planSshConfigImport } from './import-ssh-config';
import { parseSshConfig, resolveSshHosts } from './ssh-config';

export interface ImportReport {
  added: string[];
  skipped: { alias: string; reason: string }[];
  warnings: string[];
  hostsFile: string;
}

export interface ImporterContext {
  sshConfigFile: string;
  hostsFile: string;
  /** Used when an entry has no User. */
  defaultUser: string;
}

/**
 * Imports hosts from ~/.ssh/config into hosts.yaml (shared by the CLI and
 * the API). Existing hosts are kept; hosts.yaml must be valid first, so a
 * broken file is never overwritten.
 */
export function importSshConfig(context: ImporterContext): Promise<ImportReport> {
  // From the read to the write, one edit of hosts.yaml at a time (see file-lock.ts).
  return withFileLock(context.hostsFile, () => importNow(context));
}

async function importNow(context: ImporterContext): Promise<ImportReport> {
  if (!existsSync(context.sshConfigFile)) {
    throw new Error(`No SSH config found at ${context.sshConfigFile}.`);
  }
  const hostsText = existsSync(context.hostsFile)
    ? await readFile(context.hostsFile, 'utf8')
    : HOSTS_FILE_TEMPLATE;
  const current = parseHostsYaml(hostsText);
  if (!current.ok) {
    throw new Error(`Fix ${context.hostsFile} before importing:\n${current.errors.join('\n')}`);
  }

  const parsed = parseSshConfig(await readFile(context.sshConfigFile, 'utf8'));
  const plan = planSshConfigImport(
    resolveSshHosts(parsed),
    current.config.hosts,
    context.defaultUser,
  );
  if (plan.hosts.length > 0) {
    await mkdir(dirname(context.hostsFile), { recursive: true });
    await writeFileAtomic(context.hostsFile, appendHostsToYaml(hostsText, plan.hosts));
  }
  return {
    added: plan.hosts.map((host) => host.id),
    skipped: plan.skipped,
    warnings: parsed.warnings,
    hostsFile: context.hostsFile,
  };
}
