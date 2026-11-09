import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Committed defaults; always present in a checkout. */
const DEFAULTS_FILE = '.env.example';
/** Local overrides; git-ignored. */
const LOCAL_FILE = '.env';

/**
 * Walks up from `startDir` to the first directory containing an env file.
 * The server runs from apps/server in development, so the repo root is found
 * this way without hardcoding paths.
 */
export function findEnvDir(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, DEFAULTS_FILE)) || existsSync(join(dir, LOCAL_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Merges env file contents; values in `.env` override `.env.example`. */
export function mergeEnvFiles(
  defaultsContent: string | undefined,
  localContent: string | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const content of [defaultsContent, localContent]) {
    if (content === undefined) continue;
    for (const [key, value] of Object.entries(parseEnv(content))) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * Copies values into `target` without overwriting anything already set, so
 * real environment variables (e.g. from Docker) always win over files.
 */
export function applyMissingEnv(target: NodeJS.ProcessEnv, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined) target[key] = value;
  }
}

/** Loads `.env.example` then `.env` (if found) into `process.env`. */
export function loadEnvFiles(startDir: string = process.cwd()): void {
  const dir = findEnvDir(startDir);
  if (!dir) return;
  const read = (name: string) => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  applyMissingEnv(process.env, mergeEnvFiles(read(DEFAULTS_FILE), read(LOCAL_FILE)));
}
