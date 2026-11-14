import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addResourceToFile,
  patchResourceInFile,
  removeResourceFromFile,
  ResourceValidationError,
} from './resources-writer';

describe('editing resources.yaml while another entry is broken', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'resources-writer-'));
    file = join(dir, 'resources.yaml');
    writeFileSync(
      file,
      [
        'resources:',
        '  - { kind: redis, id: broken, host: cache, colour: blue }',
        '  - { kind: s3, id: media, endpoint: "http://127.0.0.1:4566" }',
        '',
      ].join('\n'),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('still lets the user change a valid entry (Allow changes on a bucket)', async () => {
    await patchResourceInFile(file, 'media', { manage: 'write' }, new Set(['manage']));
    expect(readFileSync(file, 'utf8')).toMatch(/manage: write/);
  });

  it('refuses a change that adds a new problem, naming only that problem', async () => {
    const error = await addResourceToFile(file, {
      kind: 'redis',
      id: 'b',
      host: 'x',
      port: 0,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ResourceValidationError);
    expect(String((error as ResourceValidationError).problems ?? error)).not.toMatch(/colour/);
  });

  it('lets the user remove the broken entry, and keeps positions straight after it', async () => {
    await removeResourceFromFile(file, 'broken');
    expect(readFileSync(file, 'utf8')).not.toMatch(/broken/);
    await patchResourceInFile(file, 'media', { manage: 'write' }, new Set(['manage']));
  });
});
