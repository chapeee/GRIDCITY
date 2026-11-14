import { Redis } from 'ioredis';
import type {
  ManageMode,
  RedisCommandResult,
  RedisKeyDetail,
  RedisKeySummary,
  RedisOverview,
  RedisScanResult,
} from '@app/shared';
import type { ResourceConfigOf } from '../config/resources-file';
import {
  errorMessage,
  readPassword,
  tlsOptions,
  type ConnectorContext,
} from '../connectors/connector';
import { ExploreError } from './sql';

/** One page of a collection value (hash fields, list items…). */
const PAGE = 200;
/** Strings longer than this are cut (the rest stays on the server). */
const STRING_LIMIT = 256 * 1024;

/**
 * Never run from the console: they block the connection (MONITOR, SUBSCRIBE),
 * end it (QUIT, RESET, SHUTDOWN) or switch state the view manages itself (SELECT).
 * Monitoring has its own capped, timed endpoint.
 */
const BLOCKED = new Set([
  'monitor',
  'subscribe',
  'psubscribe',
  'ssubscribe',
  'unsubscribe',
  'punsubscribe',
  'sunsubscribe',
  'sync',
  'psync',
  'shutdown',
  'debug',
  'quit',
  'reset',
  'select',
  'hello',
  'auth',
  'client|pause',
  // A transaction would leave the shared console connection queuing every
  // later command (and EXEC would run what was queued in read mode).
  'multi',
  'exec',
  'discard',
  'watch',
  'unwatch',
]);

/** Admin commands that change server state although they carry no "write" flag. */
const ADMIN_CHANGES = new Set([
  // Scripts can call any command, writes included; EVAL_RO / EVALSHA_RO / FCALL_RO
  // stay allowed because Redis itself refuses writes inside them.
  'eval',
  'evalsha',
  'fcall',
  // Messages reach the applications that subscribe: a side effect, not a read.
  'publish',
  'spublish',
  'config|set',
  'config|resetstat',
  'config|rewrite',
  'flushall',
  'flushdb',
  'replicaof',
  'slaveof',
  'failover',
  'client|kill',
  'client|no-evict',
  'script|flush',
  'script|kill',
  'function|delete',
  'function|flush',
  'function|restore',
  'function|load',
  'acl|setuser',
  'acl|deluser',
  'acl|load',
  'acl|save',
  'module|load',
  'module|unload',
  'save',
  'bgsave',
  'bgrewriteaof',
  'cluster|reset',
  'cluster|failover',
  'slowlog|reset',
  'latency|reset',
  'memory|purge',
  'swapdb',
  'migrate',
]);

interface CommandFacts {
  write: boolean;
  dangerous: boolean;
}

export class RedisExplorer {
  private readonly clients = new Map<number, Promise<Redis>>();
  private readonly facts = new Map<string, CommandFacts>();

  constructor(
    private readonly config: ResourceConfigOf<'redis'>,
    private readonly context: ConnectorContext,
    private readonly mode: () => ManageMode,
  ) {}

  private async options(db: number) {
    return {
      host: this.config.host,
      port: this.config.port,
      username: this.config.user,
      password: await readPassword(this.config, this.context),
      tls: tlsOptions(this.config),
      db,
      lazyConnect: true,
      connectTimeout: 8000,
      commandTimeout: 15_000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      connectionName: undefined,
    };
  }

  private client(db: number): Promise<Redis> {
    const existing = this.clients.get(db);
    if (existing) return existing;
    const created = (async () => {
      const next = new Redis(await this.options(db));
      next.on('error', () => undefined);
      next.on('end', () => this.clients.delete(db));
      await next.connect();
      return next;
    })();
    created.catch(() => this.clients.delete(db));
    this.clients.set(db, created);
    return created;
  }

  async serverVersion(): Promise<string | null> {
    const info = await (await this.client(0)).info('server').catch(() => '');
    const version = /redis_version:(\S+)/.exec(info)?.[1];
    const valkey = /valkey_version:(\S+)/.exec(info)?.[1];
    return valkey ? `Valkey ${valkey}` : version ? `Redis ${version}` : null;
  }

  async overview(db: number): Promise<RedisOverview> {
    const redis = await this.client(db);
    const notes: string[] = [];
    const attempt = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        notes.push(`${what}: ${errorMessage(error)}`);
        return fallback;
      }
    };
    const info = parseInfo(await attempt('INFO', () => redis.info('everything'), ''));
    const databases = Object.entries(info.keyspace ?? {})
      .map(([name, value]) => {
        const fields = Object.fromEntries(value.split(',').map((pair) => pair.split('=')));
        return {
          index: Number(name.replace('db', '')),
          keys: Number(fields.keys ?? 0),
          expires: Number(fields.expires ?? 0),
        };
      })
      .sort((a, b) => a.index - b.index);
    const slowlog = await attempt(
      'SLOWLOG GET',
      async () =>
        ((await redis.call('SLOWLOG', 'GET', '50')) as unknown[][]).map((entry) => ({
          id: Number(entry[0]),
          at: Number(entry[1]) * 1000,
          durationMicros: Number(entry[2]),
          command: ((entry[3] as unknown[]) ?? []).map((part) => String(part)),
          client: entry[4] ? String(entry[4]) : null,
        })),
      [] as RedisOverview['slowlog'],
    );
    const clients = await attempt(
      'CLIENT LIST',
      async () =>
        String(await redis.call('CLIENT', 'LIST'))
          .split('\n')
          .filter(Boolean)
          .map((line) =>
            Object.fromEntries(
              line
                .split(' ')
                .map((pair) => [
                  pair.slice(0, pair.indexOf('=')),
                  pair.slice(pair.indexOf('=') + 1),
                ]),
            ),
          ),
      [] as Record<string, string>[],
    );
    const commandStats = Object.entries(info.commandstats ?? {})
      .map(([name, value]) => {
        const fields = Object.fromEntries(value.split(',').map((pair) => pair.split('=')));
        return {
          command: name.replace(/^cmdstat_/, ''),
          calls: Number(fields.calls ?? 0),
          usecPerCall: Number(fields.usec_per_call ?? 0),
        };
      })
      .sort((a, b) => b.calls - a.calls);
    return { info, databases, slowlog, clients, commandStats, notes };
  }

  async scan(db: number, pattern: string, cursor: string, type?: string): Promise<RedisScanResult> {
    const redis = await this.client(db);
    const args: (string | number)[] = [cursor || '0', 'MATCH', pattern || '*', 'COUNT', 500];
    if (type) args.push('TYPE', type);
    const [next, keys] = (await redis.call('SCAN', ...args)) as [string, string[]];
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.type(key).ttl(key);
    const replies = (await pipeline.exec()) ?? [];
    const summaries: RedisKeySummary[] = keys.map((key, i) => ({
      key,
      type: String(replies[i * 2]?.[1] ?? 'unknown'),
      ttl: replies[i * 2 + 1]?.[0] ? null : Number(replies[i * 2 + 1]?.[1]),
    }));
    const dbSize = await redis.dbsize().catch(() => null);
    return { cursor: next, keys: summaries.sort((a, b) => a.key.localeCompare(b.key)), dbSize };
  }

  async key(db: number, key: string, offset = 0): Promise<RedisKeyDetail> {
    const redis = await this.client(db);
    const type = await redis.type(key);
    if (type === 'none')
      throw new ExploreError(`key "${key}" does not exist (it may have expired)`, 404);
    const ttl = await redis.ttl(key);
    const memoryBytes = await redis
      .call('MEMORY', 'USAGE', key)
      .then(Number)
      .catch(() => null);
    const encoding = await redis
      .call('OBJECT', 'ENCODING', key)
      .then(String)
      .catch(() => null);
    const start = Math.max(0, Math.floor(offset));
    let value: unknown;
    let length: number | null = null;
    let truncated = false;
    switch (type) {
      case 'string': {
        length = await redis.strlen(key);
        const buffer = await redis.getrangeBuffer(key, 0, STRING_LIMIT - 1);
        value = bufferText(buffer);
        truncated = length > STRING_LIMIT;
        break;
      }
      case 'hash': {
        length = await redis.hlen(key);
        if (length <= PAGE) value = await redis.hgetall(key);
        else {
          const [, flat] = await redis.hscan(key, '0', 'COUNT', PAGE);
          value = Object.fromEntries(pairs(flat));
          truncated = true;
        }
        break;
      }
      case 'list':
        length = await redis.llen(key);
        value = await redis.lrange(key, start, start + PAGE - 1);
        truncated = start + PAGE < length;
        break;
      case 'set': {
        length = await redis.scard(key);
        const [, members] = await redis.sscan(key, '0', 'COUNT', PAGE);
        value = members.sort();
        truncated = members.length < length;
        break;
      }
      case 'zset': {
        length = await redis.zcard(key);
        const flat = await redis.zrange(key, String(start), String(start + PAGE - 1), 'WITHSCORES');
        value = pairs(flat).map(([member, score]) => [member, Number(score)]);
        truncated = start + PAGE < length;
        break;
      }
      case 'stream': {
        length = await redis.xlen(key);
        value = await redis.xrevrange(key, '+', '-', 'COUNT', PAGE);
        truncated = PAGE < length;
        break;
      }
      default:
        value = null;
    }
    return { key, type, ttl, memoryBytes, encoding, length, value, truncated };
  }

  /**
   * The console. The server's own COMMAND INFO decides what counts as a write
   * (no hand-kept list), plus admin commands that change state. Dangerous
   * commands (FLUSHALL, KEYS…) need `confirm`.
   */
  async command(db: number, args: string[], confirm = false): Promise<RedisCommandResult> {
    if (args.length === 0 || !args[0]) throw new ExploreError('type a command');
    const redis = await this.client(db);
    const name = args[0].toLowerCase();
    const full = args[1] ? `${name}|${args[1].toLowerCase()}` : name;
    if (BLOCKED.has(name) || BLOCKED.has(full)) {
      throw new ExploreError(
        name === 'select'
          ? 'choose the database with the picker above'
          : name === 'monitor'
            ? 'use the Activity tab: it records MONITOR for a few seconds'
            : `${name.toUpperCase()} is not available here (it would block or end the connection)`,
        403,
      );
    }
    const facts = await this.commandFacts(redis, name, args[1]);
    const changes = facts.write || ADMIN_CHANGES.has(full) || ADMIN_CHANGES.has(name);
    if (changes && this.mode() !== 'write') {
      throw new ExploreError(
        `${args.slice(0, 2).join(' ').toUpperCase()} changes data: switch Changes on to run it`,
        403,
      );
    }
    if (facts.dangerous && !confirm) {
      throw new ExploreError(
        `CONFIRM:Redis marks ${args.slice(0, 2).join(' ').toUpperCase()} as dangerous (admin, or slow on big data sets). Run it anyway?`,
        409,
      );
    }
    const started = performance.now();
    const reply = await redis.callBuffer(args[0], ...args.slice(1));
    return {
      reply: toJson(reply),
      durationMs: Math.round(performance.now() - started),
      write: changes,
    };
  }

  private async commandFacts(redis: Redis, name: string, sub?: string): Promise<CommandFacts> {
    const cacheKey = sub ? `${name}|${sub.toLowerCase()}` : name;
    const cached = this.facts.get(cacheKey) ?? this.facts.get(name);
    if (cached) return cached;
    const info = (await redis.call('COMMAND', 'INFO', name).catch(() => null)) as
      unknown[][] | null;
    const entry = info?.[0];
    if (!entry) {
      // Unknown to the server (or COMMAND denied by ACL): treat as a write to stay safe.
      return { write: true, dangerous: false };
    }
    const flags = ((entry[2] as string[]) ?? []).map((f) => String(f).toLowerCase());
    const categories = ((entry[6] as string[]) ?? []).map((c) => String(c).toLowerCase());
    let facts: CommandFacts = {
      // may_replicate: Redis's own mark for commands that can change data without
      // a "write" flag (EVAL, FCALL, PUBLISH…).
      write: flags.includes('write') || flags.includes('may_replicate'),
      dangerous: categories.includes('@dangerous'),
    };
    // Container commands (CONFIG, CLIENT, OBJECT…): the subcommand has its own flags.
    const subcommands = (entry[9] as unknown[][] | undefined) ?? [];
    if (sub && subcommands.length > 0) {
      const match = subcommands.find(
        (s) => String(s[0]).toLowerCase() === `${name}|${sub.toLowerCase()}`,
      );
      if (match) {
        const subFlags = ((match[2] as string[]) ?? []).map((f) => String(f).toLowerCase());
        const subCategories = ((match[6] as string[]) ?? []).map((c) => String(c).toLowerCase());
        facts = {
          write: subFlags.includes('write') || subFlags.includes('may_replicate'),
          dangerous: subCategories.includes('@dangerous'),
        };
      }
    }
    this.facts.set(cacheKey, facts);
    return facts;
  }

  /** Form edits from the key view, mapped to fixed commands (always write mode). */
  async edit(db: number, op: RedisEdit): Promise<void> {
    if (this.mode() !== 'write')
      throw new ExploreError('Changes are off for this resource: switch them on to edit keys', 403);
    const redis = await this.client(db);
    switch (op.op) {
      case 'set':
        if (op.ttl && op.ttl > 0) await redis.set(op.key, op.value, 'EX', op.ttl);
        else await redis.set(op.key, op.value, 'KEEPTTL');
        return;
      case 'delete':
        await redis.unlink(...op.keys);
        return;
      case 'expire':
        if (op.ttl === null || op.ttl <= 0) await redis.persist(op.key);
        else await redis.expire(op.key, op.ttl);
        return;
      case 'rename': {
        const ok = await redis.renamenx(op.key, op.to);
        if (ok === 0) throw new ExploreError(`"${op.to}" already exists`, 409);
        return;
      }
      case 'hset':
        await redis.hset(op.key, op.field, op.value);
        return;
      case 'hdel':
        await redis.hdel(op.key, op.field);
        return;
      case 'lpush':
        await redis.lpush(op.key, op.value);
        return;
      case 'rpush':
        await redis.rpush(op.key, op.value);
        return;
      case 'lset':
        await redis.lset(op.key, op.index, op.value);
        return;
      case 'lrem':
        await redis.lrem(op.key, 1, op.value);
        return;
      case 'sadd':
        await redis.sadd(op.key, op.value);
        return;
      case 'srem':
        await redis.srem(op.key, op.value);
        return;
      case 'zadd':
        await redis.zadd(op.key, op.score, op.value);
        return;
      case 'zrem':
        await redis.zrem(op.key, op.value);
        return;
      case 'xadd':
        await redis.xadd(op.key, '*', ...Object.entries(op.fields).flat());
        return;
      case 'xdel':
        await redis.xdel(op.key, op.id);
        return;
    }
  }

  /** Records MONITOR for a few seconds on a separate connection (needs +monitor). */
  async monitor(db: number, seconds: number): Promise<{ lines: string[]; truncated: boolean }> {
    const duration = Math.max(1, Math.min(10, Math.floor(seconds))) * 1000;
    const connection = new Redis({ ...(await this.options(db)), commandTimeout: duration + 5000 });
    connection.on('error', () => undefined);
    const lines: string[] = [];
    let truncated = false;
    try {
      await connection.connect();
      const monitor = await connection.monitor();
      monitor.on('monitor', (time: string, args: string[], source: string, database: string) => {
        if (lines.length >= 1000) {
          truncated = true;
          return;
        }
        lines.push(
          `${new Date(Number(time) * 1000).toISOString().slice(11, 23)} [${database} ${source}] ${args.map(quoteArg).join(' ')}`,
        );
      });
      await new Promise((resolve) => setTimeout(resolve, duration));
      monitor.disconnect();
    } catch (error) {
      throw new ExploreError(`MONITOR is not available: ${errorMessage(error)}`, 403);
    } finally {
      connection.disconnect();
    }
    return { lines, truncated };
  }

  async close() {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(
      all.map(async (p) => (await p.catch(() => null))?.quit().catch(() => undefined)),
    );
  }
}

export type RedisEdit =
  | { op: 'set'; key: string; value: string; ttl?: number | null }
  | { op: 'delete'; keys: string[] }
  | { op: 'expire'; key: string; ttl: number | null }
  | { op: 'rename'; key: string; to: string }
  | { op: 'hset'; key: string; field: string; value: string }
  | { op: 'hdel'; key: string; field: string }
  | { op: 'lpush' | 'rpush' | 'lrem' | 'sadd' | 'srem' | 'zrem'; key: string; value: string }
  | { op: 'lset'; key: string; index: number; value: string }
  | { op: 'zadd'; key: string; value: string; score: number }
  | { op: 'xadd'; key: string; fields: Record<string, string> }
  | { op: 'xdel'; key: string; id: string };

/** INFO text -> { section: { field: value } } (section names lower case). */
export function parseInfo(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = 'default';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ')) {
      current = line.slice(2).trim().toLowerCase();
      sections[current] ??= {};
    } else if (line.includes(':')) {
      const at = line.indexOf(':');
      (sections[current] ??= {})[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  return sections;
}

function pairs(flat: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

/** UTF-8 text when it is text, otherwise a marked base64 form. */
function bufferText(buffer: Buffer): string | { $binary: string; bytes: number } {
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) && !hasControlCharacters(text)
    ? text
    : { $binary: buffer.subarray(0, 4096).toString('base64'), bytes: buffer.length };
}

/** NUL and other control bytes (tab, newline, carriage return and form feed count as text). */
function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d)
      return true;
  }
  return false;
}

function toJson(reply: unknown): unknown {
  if (Buffer.isBuffer(reply)) return bufferText(reply);
  if (Array.isArray(reply)) return reply.map(toJson);
  if (reply instanceof Error) return { error: reply.message };
  return reply ?? null;
}

const quoteArg = (arg: string) => (/^[\w:.\-/]+$/.test(arg) ? arg : JSON.stringify(arg));
