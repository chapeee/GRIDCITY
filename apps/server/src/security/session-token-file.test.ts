import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSessionToken } from './session-token';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'token-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadOrCreateSessionToken', () => {
  it('keeps the same token across restarts, so the link and cookie keep working', () => {
    const file = join(dir, 'nested', 'session-token');
    const first = loadOrCreateSessionToken(file);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadOrCreateSessionToken(file)).toBe(first);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('replaces the token on request, and a damaged file', () => {
    const file = join(dir, 'session-token');
    const first = loadOrCreateSessionToken(file);
    const rotated = loadOrCreateSessionToken(file, { rotate: true });
    expect(rotated).not.toBe(first);
    expect(readFileSync(file, 'utf8').trim()).toBe(rotated);
    writeFileSync(file, 'garbage');
    expect(loadOrCreateSessionToken(file)).not.toBe('garbage');
  });
});
