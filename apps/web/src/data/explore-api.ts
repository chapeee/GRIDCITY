import type {
  ExploreInfo,
  ManageMode,
  MongoCollectionInfo,
  MongoDatabaseInfo,
  MongoFindRequest,
  MongoFindResult,
  MongoIndexInfo,
  RedisCommandResult,
  RedisKeyDetail,
  RedisOverview,
  RedisScanResult,
  S3BucketInfo,
  S3BucketSettings,
  S3ListResult,
  S3ObjectDetail,
  S3UsageResult,
  SqlDatabase,
  SqlQueryResult,
  SqlRowChange,
  SqlRowsRequest,
  SqlRowsResult,
  SqlTableDetail,
  SqlTableRef,
} from '@app/shared';

/** The server asks for an explicit yes (Redis commands it marks dangerous). */
export class ConfirmNeeded extends Error {}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    ...(json !== undefined
      ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    confirm?: boolean;
  };
  if (!response.ok) {
    const message = body.error ?? `${response.status} ${response.statusText}`;
    if (body.confirm) throw new ConfirmNeeded(message);
    throw new Error(message);
  }
  return body;
}

const q = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();

/** Calls for one resources.yaml entry's Manage view. */
export function exploreApi(id: string) {
  const base = `/api/explore/${encodeURIComponent(id)}`;
  return {
    info: () => call<ExploreInfo>(base),
    setMode: (mode: ManageMode) =>
      call<{ ok: true; mode: ManageMode }>(`${base}/mode`, { method: 'PUT', json: { mode } }),

    sql: {
      databases: () => call<{ databases: SqlDatabase[]; current: string }>(`${base}/sql/databases`),
      tables: (db: string) => call<{ tables: SqlTableRef[] }>(`${base}/sql/tables?${q({ db })}`),
      table: (db: string, schema: string, table: string) =>
        call<SqlTableDetail>(`${base}/sql/table?${q({ db, schema, table })}`),
      rows: (db: string, request: SqlRowsRequest) =>
        call<SqlRowsResult>(`${base}/sql/rows`, { method: 'POST', json: { db, ...request } }),
      query: (db: string, sql: string) =>
        call<SqlQueryResult>(`${base}/sql/query`, { method: 'POST', json: { db, sql } }),
      row: (db: string, action: 'update' | 'insert' | 'delete', change: SqlRowChange) =>
        call<{ ok: true; affected: number }>(`${base}/sql/row`, {
          method: 'POST',
          json: { db, action, change },
        }),
    },

    mongo: {
      databases: () =>
        call<{ databases: MongoDatabaseInfo[]; current: string | null }>(`${base}/mongo/databases`),
      collections: (db: string) =>
        call<{ collections: MongoCollectionInfo[] }>(`${base}/mongo/collections?${q({ db })}`),
      find: (request: MongoFindRequest) =>
        call<MongoFindResult>(`${base}/mongo/find`, { method: 'POST', json: request }),
      aggregate: (db: string, collection: string, pipeline: string) =>
        call<MongoFindResult>(`${base}/mongo/aggregate`, {
          method: 'POST',
          json: { db, collection, pipeline },
        }),
      indexes: (db: string, collection: string) =>
        call<{ indexes: MongoIndexInfo[] }>(`${base}/mongo/indexes?${q({ db, collection })}`),
      operations: () => call<{ operations: Record<string, unknown>[] }>(`${base}/mongo/operations`),
      document: (body: {
        db: string;
        collection: string;
        action: 'insert' | 'replace' | 'delete';
        id?: string;
        document?: string;
      }) =>
        call<{ ok: true; id?: string }>(`${base}/mongo/document`, { method: 'POST', json: body }),
      admin: (body: {
        db: string;
        collection: string;
        action: 'createIndex' | 'dropIndex' | 'createCollection' | 'dropCollection';
        keys?: string;
        name?: string;
        unique?: boolean;
        sparse?: boolean;
        ttlSeconds?: number | null;
      }) =>
        call<{ ok: true; name?: string }>(`${base}/mongo/admin`, { method: 'POST', json: body }),
    },

    redis: {
      overview: (db: number) => call<RedisOverview>(`${base}/redis/overview?${q({ db })}`),
      scan: (db: number, pattern: string, cursor: string, type?: string) =>
        call<RedisScanResult>(`${base}/redis/scan`, {
          method: 'POST',
          json: { db, pattern, cursor, type },
        }),
      key: (db: number, key: string, offset = 0) =>
        call<RedisKeyDetail>(`${base}/redis/key?${q({ db, key, offset })}`),
      command: (db: number, args: string[], confirm = false) =>
        call<RedisCommandResult>(`${base}/redis/command`, {
          method: 'POST',
          json: { db, args, confirm },
        }),
      edit: (db: number, edit: Record<string, unknown>) =>
        call<{ ok: true }>(`${base}/redis/edit`, { method: 'POST', json: { db, edit } }),
      monitor: (db: number, seconds: number) =>
        call<{ lines: string[]; truncated: boolean }>(`${base}/redis/monitor`, {
          method: 'POST',
          json: { db, seconds },
        }),
    },

    s3: {
      buckets: () => call<{ buckets: S3BucketInfo[] }>(`${base}/s3/buckets`),
      list: (bucket: string, prefix: string, token?: string) =>
        call<S3ListResult>(`${base}/s3/list?${q({ bucket, prefix, token })}`),
      object: (bucket: string, key: string) =>
        call<S3ObjectDetail>(`${base}/s3/object?${q({ bucket, key })}`),
      downloadUrl: (bucket: string, key: string, inline = false) =>
        `${base}/s3/download?${q({ bucket, key, inline: inline ? '1' : undefined })}`,
      /** Streams the file to the storage through the app (progress via XHR). */
      upload: (bucket: string, key: string, file: File, onProgress?: (fraction: number) => void) =>
        new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', `${base}/s3/upload?${q({ bucket, key })}`);
          xhr.withCredentials = true;
          xhr.setRequestHeader('content-type', 'application/octet-stream');
          if (file.type) xhr.setRequestHeader('x-file-type', file.type);
          xhr.upload.onprogress = (event) =>
            event.lengthComputable && onProgress?.(event.loaded / event.total);
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else {
              let message = `${xhr.status} ${xhr.statusText}`;
              try {
                message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
              } catch {
                /* keep the status line */
              }
              reject(new Error(message));
            }
          };
          xhr.onerror = () =>
            reject(new Error('upload failed: the connection to the app was lost'));
          xhr.send(file);
        }),
      action: (body: {
        bucket: string;
        action: 'delete' | 'folder' | 'copy' | 'move' | 'tags' | 'createBucket' | 'deleteBucket';
        keys?: string[];
        prefix?: string;
        from?: string;
        to?: string;
        key?: string;
        tags?: Record<string, string>;
      }) => call<{ ok: true; count?: number }>(`${base}/s3/action`, { method: 'POST', json: body }),
      settings: (bucket: string) => call<S3BucketSettings>(`${base}/s3/settings?${q({ bucket })}`),
      setSetting: (
        bucket: string,
        setting: 'policy' | 'cors' | 'versioning',
        value: string | boolean | null,
      ) =>
        call<{ ok: true }>(`${base}/s3/settings`, {
          method: 'PUT',
          json: { bucket, setting, value },
        }),
      usage: (bucket: string) => call<S3UsageResult>(`${base}/s3/usage?${q({ bucket })}`),
    },
  };
}

export type ExploreApi = ReturnType<typeof exploreApi>;
