import { existsSync, readFileSync } from 'node:fs';
import { parseKnownHosts, type KnownHostEntry } from './known-hosts';

/** Reads every existing known_hosts file. Read only: we never write to them. */
export function readKnownHostsFiles(files: readonly string[]): KnownHostEntry[] {
  return files.flatMap((file) => {
    if (!existsSync(file)) return [];
    try {
      return parseKnownHosts(readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  });
}
