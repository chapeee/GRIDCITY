import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { loadVaultKey, overlaySecrets, SecretVault } from './secret-vault';

describe('secret vault', () => {
  const key = Buffer.alloc(32, 7);

  it('stores values encrypted and reads them back', () => {
    const db = openDatabase(':memory:');
    const vault = new SecretVault(db, key);
    vault.set('orders-db.password', 'hunter2-very-secret');
    expect(vault.get('orders-db.password')).toBe('hunter2-very-secret');
    const raw = db.prepare('SELECT data FROM secrets').get() as { data: Buffer };
    expect(raw.data.toString('utf8')).not.toContain('hunter2');
    // A fresh vault on the same database (no cache) decrypts too.
    expect(new SecretVault(db, key).get('orders-db.password')).toBe('hunter2-very-secret');
  });

  it('treats a value sealed with another key as missing, never crashes', () => {
    const db = openDatabase(':memory:');
    new SecretVault(db, key).set('a', 'value');
    expect(new SecretVault(db, Buffer.alloc(32, 9)).get('a')).toBeUndefined();
  });

  it('replaces, deletes and deletes by prefix', () => {
    const vault = new SecretVault(openDatabase(':memory:'), key);
    vault.set('media.accessKeyId', 'AKIA1');
    vault.set('media.secretAccessKey', 'shh');
    vault.set('other.password', 'p');
    vault.set('media.accessKeyId', 'AKIA2');
    expect(vault.get('media.accessKeyId')).toBe('AKIA2');
    vault.deletePrefix('media.');
    expect(vault.ids()).toEqual(['other.password']);
    vault.delete('other.password');
    expect(vault.has('other.password')).toBe(false);
  });

  it('creates a key file once and reuses it; accepts SECRETS_KEY', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vault-')), 'vault.key');
    const first = loadVaultKey(file);
    expect(first).toHaveLength(32);
    expect(loadVaultKey(file).equals(first)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(first.toString('base64'));
    const env = Buffer.alloc(32, 3).toString('base64');
    expect(loadVaultKey(file, env).equals(Buffer.alloc(32, 3))).toBe(true);
    expect(() => loadVaultKey(file, 'c2hvcnQ=')).toThrow(/32 bytes/);
  });

  it('overlays one-time values over the vault', () => {
    const vault = new SecretVault(openDatabase(':memory:'), key);
    vault.set('x', 'stored');
    const overlay = overlaySecrets({ y: 'typed' }, vault);
    expect([overlay.get('x'), overlay.get('y'), overlay.get('z')]).toEqual([
      'stored',
      'typed',
      undefined,
    ]);
  });
});
