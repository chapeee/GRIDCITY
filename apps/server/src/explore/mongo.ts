import { EJSON } from 'bson';
import { MongoClient, type Document, type Sort } from 'mongodb';
import type {
  ManageMode,
  MongoCollectionInfo,
  MongoDatabaseInfo,
  MongoFindRequest,
  MongoFindResult,
  MongoIndexInfo,
} from '@app/shared';
import type { ResourceConfigOf } from '../config/resources-file';
import { readPassword, type ConnectorContext } from '../connectors/connector';
import { ExploreError } from './sql';

const MAX_DOCS = 500;
const TIME_LIMIT_MS = 30_000;

/** MongoDB: databases, collections, documents, indexes. Read mode is enforced here. */
export class MongoExplorer {
  private client: Promise<MongoClient> | null = null;

  constructor(
    private readonly config: ResourceConfigOf<'mongodb'>,
    private readonly context: ConnectorContext,
    private readonly mode: () => ManageMode,
  ) {}

  private connect(): Promise<MongoClient> {
    if (this.client) return this.client;
    const created = (async () => {
      const password = await readPassword(this.config, this.context);
      const { config } = this;
      const next = new MongoClient(config.url, {
        ...(config.user || password
          ? {
              auth: {
                username:
                  config.user ?? new URL(config.url.replace(/^mongodb\+srv/, 'mongodb')).username,
                password,
              },
            }
          : {}),
        ...(config.authSource ? { authSource: config.authSource } : {}),
        ...(config.tls !== undefined ? { tls: config.tls } : {}),
        ...(config.tlsVerify === false ? { tlsAllowInvalidCertificates: true } : {}),
        ...(config.tlsCa ? { ca: config.tlsCa } : {}),
        appName: `${this.context.appName} manage`,
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        maxPoolSize: 3,
        directConnection: !config.url.startsWith('mongodb+srv') && !/replicaSet=/.test(config.url),
      });
      await next.connect();
      return next;
    })();
    created.catch(() => {
      this.client = null;
    });
    this.client = created;
    return created;
  }

  private requireWrite() {
    if (this.mode() !== 'write') {
      throw new ExploreError(
        'Changes are off for this resource: switch them on to change documents',
        403,
      );
    }
  }

  async serverVersion(): Promise<string | null> {
    const client = await this.connect();
    const info = await client
      .db('admin')
      .command({ buildInfo: 1 })
      .catch(() => null);
    return info?.version ? `MongoDB ${String(info.version)}` : null;
  }

  /** The URL's database when it names one (shown first). */
  defaultDatabase(): string | null {
    const path = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(this.config.url)?.[1];
    return path ? decodeURIComponent(path) : null;
  }

  async databases(): Promise<MongoDatabaseInfo[]> {
    const client = await this.connect();
    let names: { name: string; sizeBytes: number | null }[];
    try {
      const listed = await client.db('admin').admin().listDatabases({ nameOnly: false });
      names = listed.databases.map((d) => ({ name: d.name, sizeBytes: d.sizeOnDisk ?? null }));
    } catch {
      // Users limited to one database cannot list all: fall back to the URL's database.
      const own = this.defaultDatabase() ?? this.config.authSource ?? 'test';
      names = [{ name: own, sizeBytes: null }];
    }
    return names.map((d) => ({ ...d, collections: [] }));
  }

  async collections(database: string): Promise<MongoCollectionInfo[]> {
    const db = (await this.connect()).db(database);
    const listed = await db.listCollections({}, { nameOnly: false }).toArray();
    const out: MongoCollectionInfo[] = [];
    for (const entry of listed.slice(0, 500)) {
      const info: MongoCollectionInfo = {
        name: entry.name,
        type: String(entry.type ?? 'collection'),
        count: null,
        sizeBytes: null,
        indexCount: null,
      };
      if (entry.type === 'collection' || entry.type === undefined) {
        const stats = await db
          .collection(entry.name)
          .aggregate([{ $collStats: { storageStats: {}, count: {} } }])
          .toArray()
          .catch(() => []);
        const storage = (stats[0]?.storageStats ?? {}) as Document;
        info.count = num(storage.count) ?? num(stats[0]?.count);
        info.sizeBytes = num(storage.size);
        info.indexCount = num(storage.nindexes);
        if (info.count === null) {
          info.count = await db
            .collection(entry.name)
            .estimatedDocumentCount()
            .catch(() => null);
        }
      }
      out.push(info);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async find(request: MongoFindRequest): Promise<MongoFindResult> {
    const collection = (await this.connect()).db(request.database).collection(request.collection);
    const filter = parseJson(request.filter, 'filter') ?? {};
    const sort = parseJson(request.sort, 'sort');
    const projection = parseJson(request.projection, 'projection');
    const limit = Math.max(1, Math.min(MAX_DOCS, Math.floor(request.limit || 50)));
    const started = performance.now();
    const documents = await collection
      .find(filter, {
        ...(sort ? { sort: sort as Sort } : {}),
        ...(projection ? { projection: projection as Document } : {}),
        skip: Math.max(0, Math.floor(request.skip || 0)),
        limit,
        maxTimeMS: TIME_LIMIT_MS,
      })
      .toArray();
    const durationMs = Math.round(performance.now() - started);
    const total = await collection.countDocuments(filter, { maxTimeMS: 5000 }).catch(() => null);
    return { documents: documents.map(serialize), total, durationMs };
  }

  async aggregate(
    database: string,
    collection: string,
    pipelineText: string,
  ): Promise<MongoFindResult> {
    const pipeline = parseJson(pipelineText, 'pipeline');
    if (!Array.isArray(pipeline))
      throw new ExploreError('the pipeline must be a JSON array of stages');
    const writes = pipeline.some(
      (stage) => stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage),
    );
    if (writes) this.requireWrite();
    const started = performance.now();
    const documents = await (
      await this.connect()
    )
      .db(database)
      .collection(collection)
      .aggregate([...pipeline, ...(writes ? [] : [{ $limit: MAX_DOCS }])], {
        maxTimeMS: TIME_LIMIT_MS,
      })
      .toArray();
    return {
      documents: documents.map(serialize),
      total: null,
      durationMs: Math.round(performance.now() - started),
    };
  }

  async indexes(database: string, collection: string): Promise<MongoIndexInfo[]> {
    const list = await (await this.connect()).db(database).collection(collection).indexes();
    return list.map((index) => ({
      name: String(index.name),
      key: serialize(index.key as Document),
      unique: index.unique === true,
      sparse: index.sparse === true,
      ttlSeconds: typeof index.expireAfterSeconds === 'number' ? index.expireAfterSeconds : null,
    }));
  }

  async insert(database: string, collection: string, documentText: string): Promise<string> {
    this.requireWrite();
    const document = parseJson(documentText, 'document');
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new ExploreError('the document must be a JSON object');
    }
    const result = await (
      await this.connect()
    )
      .db(database)
      .collection(collection)
      .insertOne(document as Document);
    return EJSON.stringify(result.insertedId, { relaxed: true });
  }

  /** Replaces one document by its _id (the _id itself cannot change). */
  async replace(
    database: string,
    collection: string,
    idText: string,
    documentText: string,
  ): Promise<void> {
    this.requireWrite();
    const id = parseJson(idText, '_id');
    const document = parseJson(documentText, 'document') as Document | null;
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new ExploreError('the document must be a JSON object');
    }
    delete document._id;
    const result = await (
      await this.connect()
    )
      .db(database)
      .collection(collection)
      .replaceOne({ _id: id as never }, document);
    if (result.matchedCount !== 1)
      throw new ExploreError('the document no longer exists: reload', 409);
  }

  async remove(database: string, collection: string, idText: string): Promise<void> {
    this.requireWrite();
    const id = parseJson(idText, '_id');
    const result = await (
      await this.connect()
    )
      .db(database)
      .collection(collection)
      .deleteOne({ _id: id as never });
    if (result.deletedCount !== 1)
      throw new ExploreError('the document no longer exists: reload', 409);
  }

  async createIndex(
    database: string,
    collection: string,
    keysText: string,
    options: { unique?: boolean; sparse?: boolean; ttlSeconds?: number | null; name?: string },
  ): Promise<string> {
    this.requireWrite();
    const keys = parseJson(keysText, 'index keys');
    if (!keys || typeof keys !== 'object' || Array.isArray(keys))
      throw new ExploreError('keys must be an object like {"field": 1}');
    return (await this.connect())
      .db(database)
      .collection(collection)
      .createIndex(keys as Document, {
        ...(options.unique ? { unique: true } : {}),
        ...(options.sparse ? { sparse: true } : {}),
        ...(options.ttlSeconds ? { expireAfterSeconds: options.ttlSeconds } : {}),
        ...(options.name ? { name: options.name } : {}),
      });
  }

  async dropIndex(database: string, collection: string, name: string): Promise<void> {
    this.requireWrite();
    if (name === '_id_') throw new ExploreError('the _id index cannot be dropped');
    await (await this.connect()).db(database).collection(collection).dropIndex(name);
  }

  async createCollection(database: string, name: string): Promise<void> {
    this.requireWrite();
    await (await this.connect()).db(database).createCollection(name);
  }

  async dropCollection(database: string, name: string): Promise<void> {
    this.requireWrite();
    await (await this.connect()).db(database).collection(name).drop();
  }

  /** Operations running now (needs inprog / clusterMonitor; otherwise only one's own). */
  async currentOps(): Promise<Record<string, unknown>[]> {
    const ops = await (
      await this.connect()
    )
      .db('admin')
      .aggregate([
        { $currentOp: { allUsers: true, idleConnections: false } },
        // Drivers' awaitable heartbeats (this app's too) wait on purpose: not interesting.
        { $match: { 'command.hello': { $exists: false }, 'command.isMaster': { $exists: false } } },
        { $limit: 200 },
      ])
      .toArray()
      .catch(async () => {
        const result = await (await this.connect()).db('admin').command({ currentOp: 1 });
        return (result.inprog as Document[]) ?? [];
      });
    return ops.map((op) =>
      serialize({
        opid: op.opid,
        op: op.op,
        ns: op.ns,
        secs: op.secs_running,
        client: op.client,
        appName: op.appName,
        command: op.command,
        desc: op.desc,
      }),
    );
  }

  async close() {
    const current = this.client;
    this.client = null;
    await (await current?.catch(() => null))?.close().catch(() => undefined);
  }
}

function parseJson(text: string | undefined, what: string): unknown {
  if (text === undefined || text.trim() === '') return null;
  try {
    return EJSON.parse(text, { relaxed: true });
  } catch (error) {
    throw new ExploreError(`${what} is not valid JSON: ${(error as Error).message}`);
  }
}

function serialize(document: Document): Record<string, unknown> {
  return EJSON.serialize(document, { relaxed: true }) as Record<string, unknown>;
}

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return value === undefined || value === null || !Number.isFinite(n) ? null : n;
};
