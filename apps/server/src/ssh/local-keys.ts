import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import ssh2, { type ParsedKey } from 'ssh2';
import { classifyKeyText, MAX_KEY_FILE_BYTES } from './key-import';
import { fingerprintSha256, presentedKeyFromBlob } from './known-hosts';

/**
 * An SSH key the user could connect with. Only the *public* half ever leaves
 * the server process; private key files are read only to check whether they
 * are usable without a passphrase.
 */
export interface LocalKey {
  /** "agent:<fingerprint>" or "file:<file name>". */
  id: string;
  source: 'agent' | 'file';
  /** "id_ed25519 · ssh-ed25519" */
  label: string;
  keyType: string;
  fingerprint: string;
  /** OpenSSH public key line, e.g. "ssh-ed25519 AAAA… comment". */
  publicKey: string;
  /** Private key file (file keys only). */
  privatePath?: string;
  /** Usable without asking for a passphrase. */
  usable: boolean;
  /** Why a key is not usable, or a hint. */
  note?: string;
}

export interface KeyDiscoveryContext {
  sshDir: string;
  /** ssh-agent socket or Windows pipe, if any. */
  agentSocket?: string;
}

const AGENT_TIMEOUT_MS = 2000;

/** Keys from ssh-agent first (they work even when passphrase-protected), then key files. */
export async function listLocalKeys(context: KeyDiscoveryContext): Promise<LocalKey[]> {
  const agentKeys = context.agentSocket ? await listAgentKeys(context.agentSocket) : [];
  const fileKeys = await listFileKeys(context.sshDir);
  const inAgent = new Set(agentKeys.map((key) => key.fingerprint));
  return [
    ...agentKeys,
    ...fileKeys.map((key) =>
      inAgent.has(key.fingerprint) ? { ...key, note: 'also loaded in ssh-agent' } : key,
    ),
  ];
}

function listAgentKeys(socket: string): Promise<LocalKey[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), AGENT_TIMEOUT_MS);
    try {
      ssh2.createAgent(socket).getIdentities((error, keys) => {
        clearTimeout(timer);
        if (error || !keys) return resolve([]);
        resolve(
          keys
            .filter(
              (key): key is ParsedKey =>
                typeof key === 'object' && key !== null && 'getPublicSSH' in key,
            )
            .map((key) => {
              const blob = key.getPublicSSH();
              const { keyType } = presentedKeyFromBlob(blob);
              const fingerprint = fingerprintSha256(blob);
              const comment = key.comment || 'key';
              return {
                id: `agent:${fingerprint}`,
                source: 'agent' as const,
                label: `${comment} · ${keyType} (ssh-agent)`,
                keyType,
                fingerprint,
                publicKey: `${keyType} ${blob.toString('base64')} ${comment}`.trim(),
                usable: true,
              };
            }),
        );
      });
    } catch {
      clearTimeout(timer);
      resolve([]); // no agent running
    }
  });
}

async function listFileKeys(sshDir: string): Promise<LocalKey[]> {
  if (!existsSync(sshDir)) return [];
  const names = await readdir(sshDir).catch(() => [] as string[]);
  const keys: LocalKey[] = [];

  // Private keys without a .pub beside them (AWS .pem files, copied keys).
  const loneNames = names
    .filter((name) => !name.endsWith('.pub') && !names.includes(`${name}.pub`))
    .sort();
  for (const name of loneNames) {
    const key = await readLonePrivateKey(join(sshDir, name), name);
    if (key) keys.push(key);
  }

  for (const publicName of names.filter((name) => name.endsWith('.pub')).sort()) {
    const privateName = publicName.slice(0, -'.pub'.length);
    const privatePath = join(sshDir, privateName);
    if (!names.includes(privateName)) continue;

    const publicLine = (await readFile(join(sshDir, publicName), 'utf8').catch(() => '')).trim();
    const [keyType, keyBase64] = publicLine.split(/\s+/);
    if (!keyType || !keyBase64) continue;
    const fingerprint = fingerprintSha256(Buffer.from(keyBase64, 'base64'));

    const parsed = ssh2.utils.parseKey(await readFile(privatePath).catch(() => Buffer.alloc(0)));
    const encrypted = parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message);
    const usable = !(parsed instanceof Error);
    keys.push({
      id: `file:${privateName}`,
      source: 'file',
      label: `${privateName} · ${keyType}`,
      keyType,
      fingerprint,
      publicKey: publicLine,
      privatePath,
      usable,
      ...(usable
        ? {}
        : {
            note: encrypted
              ? 'passphrase-protected: load it into ssh-agent (ssh-add) to use it'
              : 'not a supported private key',
          }),
    });
  }
  return keys.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A private key file with no .pub: the public half is derived from it.
 * Returns null for anything that is not a private key (config, known_hosts…).
 */
async function readLonePrivateKey(path: string, name: string): Promise<LocalKey | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_KEY_FILE_BYTES) return null;
  const text = await readFile(path, 'utf8').catch(() => '');
  const kind = classifyKeyText(text);
  if (kind !== 'private' && kind !== 'ppk') return null;

  const unusable = (note: string): LocalKey => ({
    id: `file:${name}`,
    source: 'file',
    label: `${name} · private key`,
    keyType: 'unknown',
    fingerprint: '',
    publicKey: '',
    privatePath: path,
    usable: false,
    note,
  });

  const parsed = ssh2.utils.parseKey(text);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) {
    if (kind === 'ppk') return unusable('PuTTY key: use "Upload a key file" to convert it');
    return unusable(
      key && /passphrase|encrypted/i.test(key.message)
        ? 'passphrase-protected: load it into ssh-agent (ssh-add) to use it'
        : 'not a supported private key',
    );
  }
  const blob = key.getPublicSSH();
  const { keyType } = presentedKeyFromBlob(blob);
  return {
    id: `file:${name}`,
    source: 'file',
    label: `${name} · ${keyType}`,
    keyType,
    fingerprint: fingerprintSha256(blob),
    publicKey: `${keyType} ${blob.toString('base64')} ${key.comment || name}`.trim(),
    privatePath: path,
    usable: true,
  };
}
