import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Config edits are read, change, write. Two at once (two browser tabs, a quick
 * double add, an import while editing) would each read the same old file and
 * the last write would drop the other's change, or interleave and corrupt it.
 * Every writer of a file waits for the one before it.
 */
const queues = new Map<string, Promise<unknown>>();

export function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

/**
 * Writes the whole file or nothing: a temporary file next to it, then a rename.
 * The live reload never sees half a file. Windows can refuse the rename for a
 * moment (an antivirus or indexer holding the file), so it is retried briefly.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await rm(temporary, { force: true });
        throw error;
      }
      await new Promise((done) => setTimeout(done, 50 * (attempt + 1)));
    }
  }
}
