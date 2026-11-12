/**
 * The Manage view: what the server's explorers return. One shape for every
 * SQL engine (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite) so the browser
 * has a single SQL manager; MongoDB, Redis and object storage have their own.
 *
 * Values cross the wire as JSON: big integers and decimals as strings, dates
 * as ISO strings, binary as `{ $binary: base64, bytes }` (cut to a preview).
 */

/** Which kinds have a Manage view. */
export const MANAGEABLE_KINDS = [
  'postgres',
  'mysql',
  'mssql',
  'sqlite',
  'mongodb',
  'redis',
  's3',
] as const;
export type ManageableKind = (typeof MANAGEABLE_KINDS)[number];
export const SQL_KINDS = ['postgres', 'mysql', 'mssql', 'sqlite'] as const;
export type SqlKind = (typeof SQL_KINDS)[number];

export const isManageable = (kind: string): kind is ManageableKind =>
  (MANAGEABLE_KINDS as readonly string[]).includes(kind);
export const isSqlKind = (kind: string): kind is SqlKind =>
  (SQL_KINDS as readonly string[]).includes(kind);

/** read: browse and read-only queries. write: changes too (audited). */
export type ManageMode = 'read' | 'write';

export interface ExploreInfo {
  id: string;
  name: string;
  kind: ManageableKind;
  mode: ManageMode;
  /** Engine and version line, e.g. "PostgreSQL 17.11". */
  server: string | null;
  /** Where it is, without credentials. */
  target: string;
}

// ---------------------------------------------------------------- SQL

export interface SqlDatabase {
  name: string;
  /** Bytes, when the engine reports it cheaply. */
  sizeBytes: number | null;
  current: boolean;
}

export interface SqlTableRef {
  /** Schema (PostgreSQL, SQL Server), database (MySQL), or "main" (SQLite). */
  schema: string;
  name: string;
  type: 'table' | 'view';
  /** Estimate from statistics; exact counts are a separate request. */
  rowEstimate: number | null;
  sizeBytes: number | null;
}

export interface SqlColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
  autoIncrement: boolean;
  comment: string | null;
}

export interface SqlIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface SqlForeignKey {
  name: string;
  /** This table's columns ... */
  columns: string[];
  /** ... point at these columns of that table. */
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface SqlTableDetail {
  schema: string;
  name: string;
  type: 'table' | 'view';
  columns: SqlColumn[];
  indexes: SqlIndex[];
  /** Relationships this table starts. */
  foreignKeys: SqlForeignKey[];
  /** Relationships from other tables to this one. */
  referencedBy: (SqlForeignKey & { schema: string; table: string })[];
  /** CREATE statement or view definition when the engine can produce it. */
  ddl: string | null;
  rowEstimate: number | null;
}

export type SqlValue =
  | string
  | number
  | boolean
  | null
  | { $binary: string; bytes: number }
  | Record<string, unknown>
  | unknown[];

export interface SqlResultSet {
  columns: { name: string; type: string | null }[];
  rows: SqlValue[][];
  /** Rows changed by INSERT/UPDATE/DELETE, when reported. */
  affected: number | null;
  /** More rows existed than were returned. */
  truncated: boolean;
  /** The statement kind as the engine reports it (SELECT, UPDATE, …). */
  command: string | null;
}

export interface SqlQueryResult {
  results: SqlResultSet[];
  durationMs: number;
  /** read: the statement ran in a read-only (or rolled back) transaction. */
  mode: ManageMode;
}

export interface SqlRowsRequest {
  schema: string;
  table: string;
  limit: number;
  offset: number;
  orderBy?: string;
  descending?: boolean;
  /** Column = value filters (exact match), ANDed. */
  where?: Record<string, SqlValue>;
  /** Free text: rows where any text column contains it. */
  search?: string;
}

export interface SqlRowsResult extends SqlResultSet {
  /** Total matching rows when cheap to count (capped work), else null. */
  total: number | null;
  primaryKey: string[];
}

/** A row is addressed by its primary key values (or every column when it has none). */
export interface SqlRowChange {
  schema: string;
  table: string;
  key: Record<string, SqlValue>;
  values?: Record<string, SqlValue>;
}

// ---------------------------------------------------------------- MongoDB

export interface MongoDatabaseInfo {
  name: string;
  sizeBytes: number | null;
  collections: MongoCollectionInfo[];
}

export interface MongoCollectionInfo {
  name: string;
  type: 'collection' | 'view' | 'timeseries' | string;
  count: number | null;
  sizeBytes: number | null;
  indexCount: number | null;
}

export interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique: boolean;
  sparse: boolean;
  ttlSeconds: number | null;
}

export interface MongoFindRequest {
  database: string;
  collection: string;
  /** Extended JSON text. */
  filter?: string;
  sort?: string;
  projection?: string;
  limit: number;
  skip: number;
}

export interface MongoFindResult {
  /** Documents as relaxed Extended JSON (so _id round-trips). */
  documents: Record<string, unknown>[];
  total: number | null;
  durationMs: number;
}

// ---------------------------------------------------------------- Redis

export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | string;

export interface RedisKeySummary {
  key: string;
  type: RedisKeyType;
  /** Seconds; -1 no expiry; null unknown. */
  ttl: number | null;
}

export interface RedisScanResult {
  cursor: string;
  keys: RedisKeySummary[];
  /** Keys in the selected database (DBSIZE). */
  dbSize: number | null;
}

export interface RedisKeyDetail {
  key: string;
  type: RedisKeyType;
  ttl: number | null;
  memoryBytes: number | null;
  encoding: string | null;
  /** Number of elements (or string length). */
  length: number | null;
  /**
   * string: the text (cut at 256 KiB); hash: field -> value; list: items;
   * set: members; zset: [member, score]; stream: entries [id, fields].
   */
  value: unknown;
  /** The value was cut to a page. */
  truncated: boolean;
}

export interface RedisCommandResult {
  /** The reply, converted to JSON (buffers as text). */
  reply: unknown;
  durationMs: number;
  /** Whether the server classifies the command as a write. */
  write: boolean;
}

export interface RedisOverview {
  info: Record<string, Record<string, string>>;
  databases: { index: number; keys: number; expires: number }[];
  slowlog: {
    id: number;
    at: number;
    durationMicros: number;
    command: string[];
    client: string | null;
  }[];
  clients: Record<string, string>[];
  commandStats: { command: string; calls: number; usecPerCall: number }[];
  /** Messages that could not be read (missing ACL permissions, disabled commands). */
  notes: string[];
}

// ---------------------------------------------------------------- Object storage

export interface S3BucketInfo {
  name: string;
  createdAt: string | null;
}

export interface S3ListResult {
  bucket: string;
  prefix: string;
  folders: string[];
  objects: S3ObjectInfo[];
  nextToken: string | null;
}

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
}

export interface S3ObjectDetail extends S3ObjectInfo {
  contentType: string | null;
  metadata: Record<string, string>;
  cacheControl: string | null;
  versionId: string | null;
  tags: Record<string, string> | null;
}

export interface S3BucketSettings {
  region: string | null;
  versioning: string | null;
  /** Bucket policy JSON text, or null when there is none. */
  policy: string | null;
  cors: string | null;
  lifecycle: string | null;
  publicAccessBlock: Record<string, boolean> | null;
  acl: { grantee: string; permission: string }[] | null;
  encryption: string | null;
  /** Settings the provider did not answer (not supported, or access denied). */
  notes: string[];
}

export interface S3UsageResult {
  bucket: string;
  /** Top-level folders (and "(root files)") by size. */
  byPrefix: { prefix: string; objects: number; bytes: number }[];
  totalObjects: number;
  totalBytes: number;
  /** Counting stopped at the object limit. */
  capped: boolean;
}
