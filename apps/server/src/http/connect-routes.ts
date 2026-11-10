import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parseHostTarget } from '../config/host-target';
import { generateKey, KeyExistsError } from '../ssh/generate-key';
import {
  importPrivateKey,
  KeyImportError,
  KeyNameTakenError,
  MAX_KEY_FILE_BYTES,
} from '../ssh/key-import';
import {
  HostKeyMismatchError,
  installPublicKey,
  PasswordRejectedError,
  probeHostKey,
  trustHostKey,
  type HostEndpoint,
  type OpenSocket,
} from '../ssh/host-key-setup';
import { openThroughJump } from '../ssh/jump';
import { knownHostsName, verifyHostKey, type KnownHostEntry } from '../ssh/known-hosts';
import { listLocalKeys } from '../ssh/local-keys';
import type { AuditLog } from '../storage/audit-log';

export interface ConnectDependencies {
  sshDir: string;
  /** The known_hosts file the user confirms keys into (the first one). */
  knownHostsFile: string;
  loadKnownHosts(): KnownHostEntry[];
  agentSocket?: string;
  /** File name for a generated key, e.g. "example_ed25519" (from PROJECT_NAME). */
  keyBaseName: string;
  keyComment: string;
  defaultUser: string;
  audit: AuditLog;
}

/** A jump host as typed, and the key to log in to it with. */
const JumpSchema = z.object({ target: z.string().trim().min(1), keyId: z.string().min(1) });
const TargetSchema = z.object({
  target: z.string().trim().min(1),
  jump: JumpSchema.optional(),
});
const TrustSchema = TargetSchema.extend({ fingerprint: z.string().startsWith('SHA256:') });
const ImportSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  /** The key file's text; validated by importPrivateKey, never logged. */
  content: z.string().min(1).max(MAX_KEY_FILE_BYTES),
});
const InstallSchema = TargetSchema.extend({
  keyId: z.string().min(1),
  /** Used once for this request, never stored or logged. */
  password: z.string().min(1).max(1024),
});

/**
 * The "Connect a server" flow: list or create a key, confirm and trust the
 * host key, install the public key with the password once. Each step is an
 * explicit user action in the UI; nothing is trusted or installed implicitly.
 */
export function registerConnectRoutes(app: FastifyInstance, deps: ConnectDependencies): void {
  const endpointFrom = (target: string): HostEndpoint | null => {
    const parsed = parseHostTarget(target);
    return parsed
      ? { address: parsed.address, port: parsed.port ?? 22, user: parsed.user ?? deps.defaultUser }
      : null;
  };
  const badRequest = (reply: FastifyReply, message: string) =>
    reply.code(422).send({ error: message });
  const notAnAddress = (target: string) =>
    `"${target}" is not an SSH address. Use host, user@host or user@host:port.`;
  const keys = () => listLocalKeys({ sshDir: deps.sshDir, agentSocket: deps.agentSocket });

  /**
   * For a server behind a bastion: a factory that opens a new tunnel each
   * call (probe and trust each need their own), closing the bastion
   * connections when the request is done.
   */
  const tunnelFactory = async (
    jump: z.infer<typeof JumpSchema> | undefined,
    destination: HostEndpoint,
    cleanup: (() => void)[],
  ): Promise<OpenSocket | undefined> => {
    if (!jump) return undefined;
    const via = endpointFrom(jump.target);
    if (!via) throw new Error(notAnAddress(jump.target));
    const key = (await keys()).find((k) => k.id === jump.keyId);
    if (!key) throw new Error('Choose a key for the jump host first.');
    const auth =
      key.source === 'agent'
        ? { agent: deps.agentSocket }
        : { privateKey: await readFile(key.privatePath!) };
    return async () => {
      const tunnel = await openThroughJump({
        jump: via,
        auth,
        knownHosts: deps.loadKnownHosts(),
        destination,
      });
      cleanup.push(() => tunnel.client.end());
      return tunnel.sock;
    };
  };

  app.get('/api/ssh/keys', async () => ({ keys: await keys(), sshDir: deps.sshDir }));

  app.post('/api/ssh/keys', async (_request, reply) => {
    try {
      const generated = await generateKey({
        sshDir: deps.sshDir,
        baseName: deps.keyBaseName,
        comment: deps.keyComment,
      });
      const key = (await keys()).find((k) => k.privatePath === generated.privatePath);
      deps.audit.append('key_created', null, key ? `${key.keyType} ${key.fingerprint}` : null);
      return reply.code(201).send({ key });
    } catch (error) {
      if (error instanceof KeyExistsError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  // Upload a key the user already has (.pem, .ppk, OpenSSH). The private key
  // travels once over loopback, is validated, saved to the SSH folder and
  // never logged or returned; only its public half comes back.
  app.post('/api/ssh/keys/import', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const body = ImportSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, 'Choose a key file to upload.');
    try {
      const imported = await importPrivateKey({ sshDir: deps.sshDir, ...body.data });
      const key = (await keys()).find((k) => k.privatePath === imported.privatePath);
      if (imported.created) {
        deps.audit.append('key_imported', null, `${key?.keyType ?? 'key'} ${imported.fingerprint}`);
      }
      return reply.code(imported.created ? 201 : 200).send({ key, created: imported.created });
    } catch (error) {
      if (error instanceof KeyNameTakenError) return reply.code(409).send({ error: error.message });
      if (error instanceof KeyImportError) return badRequest(reply, error.message);
      throw error;
    }
  });

  app.post('/api/connect/probe', async (request, reply) => {
    const body = TargetSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, 'Enter an address, e.g. root@192.168.1.155');
    const endpoint = endpointFrom(body.data.target);
    if (!endpoint) return badRequest(reply, notAnAddress(body.data.target));
    const cleanup: (() => void)[] = [];
    try {
      const probed = await probeHostKey(
        endpoint,
        await tunnelFactory(body.data.jump, endpoint, cleanup),
      );
      const { verdict } = verifyHostKey(
        deps.loadKnownHosts(),
        knownHostsName(endpoint.address, endpoint.port),
        probed,
      );
      return { endpoint, keyType: probed.keyType, fingerprint: probed.fingerprint, trust: verdict };
    } catch (error) {
      return badRequest(reply, (error as Error).message);
    } finally {
      cleanup.forEach((close) => close());
    }
  });

  app.post('/api/connect/trust', async (request, reply) => {
    const body = TrustSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, 'A confirmed SHA256 fingerprint is required.');
    const endpoint = endpointFrom(body.data.target);
    if (!endpoint) return badRequest(reply, notAnAddress(body.data.target));
    const cleanup: (() => void)[] = [];
    try {
      const result = await trustHostKey({
        endpoint,
        confirmedFingerprint: body.data.fingerprint,
        knownHosts: deps.loadKnownHosts(),
        knownHostsFile: deps.knownHostsFile,
        openSocket: await tunnelFactory(body.data.jump, endpoint, cleanup),
      });
      if (result === 'added') {
        deps.audit.append(
          'host_key_trusted',
          null,
          `${knownHostsName(endpoint.address, endpoint.port)} ${body.data.fingerprint}`,
        );
      }
      return { result };
    } catch (error) {
      if (error instanceof HostKeyMismatchError)
        return reply.code(409).send({ error: error.message });
      return badRequest(reply, (error as Error).message);
    } finally {
      cleanup.forEach((close) => close());
    }
  });

  app.post('/api/connect/install', async (request, reply) => {
    const body = InstallSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, 'Choose a key and enter the server password.');
    const endpoint = endpointFrom(body.data.target);
    if (!endpoint) return badRequest(reply, notAnAddress(body.data.target));
    const key = (await keys()).find((k) => k.id === body.data.keyId);
    if (!key) return badRequest(reply, 'That key is no longer available.');
    try {
      await installPublicKey({
        endpoint,
        publicKey: key.publicKey,
        password: body.data.password,
        knownHosts: deps.loadKnownHosts(),
      });
      deps.audit.append(
        'key_installed',
        null,
        `${key.keyType} ${key.fingerprint} on ${endpoint.user}@${knownHostsName(endpoint.address, endpoint.port)}`,
      );
      return { installed: true };
    } catch (error) {
      // 422, not 401: 401 means "your session expired" to the browser.
      if (error instanceof PasswordRejectedError)
        return reply.code(422).send({ error: error.message });
      if (error instanceof HostKeyMismatchError)
        return reply.code(409).send({ error: error.message });
      return badRequest(reply, (error as Error).message);
    }
  });
}
