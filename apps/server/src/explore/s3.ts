import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketCorsCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectsCommand,
  GetBucketAclCommand,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  ManageMode,
  S3BucketInfo,
  S3BucketSettings,
  S3ListResult,
  S3ObjectDetail,
  S3UsageResult,
} from '@app/shared';
import type { ResourceConfigOf } from '../config/resources-file';
import { errorMessage, type ConnectorContext } from '../connectors/connector';
import { clientConfig } from '../connectors/s3';
import { ExploreError } from './sql';

const USAGE_OBJECT_LIMIT = 200_000;

/**
 * Object storage (AWS S3, Spaces, MinIO, R2, LocalStack…): browse, upload,
 * download, delete, copy, and bucket settings (policy, CORS, versioning).
 * Downloads and uploads stream through the app, so endpoints that only this
 * machine can reach (localhost, Docker networks) work too.
 */
export class S3Explorer {
  private readonly s3: S3Client;

  constructor(
    private readonly config: ResourceConfigOf<'s3'>,
    context: ConnectorContext,
    private readonly mode: () => ManageMode,
  ) {
    this.s3 = new S3Client({ ...clientConfig(config, context), maxAttempts: 3 });
  }

  private requireWrite() {
    if (this.mode() !== 'write') {
      throw new ExploreError(
        'Changes are off for this resource: switch them on to change objects',
        403,
      );
    }
  }

  /** Buckets the entry watches: its list, or every bucket the keys can see. */
  async buckets(): Promise<S3BucketInfo[]> {
    if (this.config.buckets)
      return [...this.config.buckets].sort().map((name) => ({ name, createdAt: null }));
    const response = await this.s3.send(new ListBucketsCommand({}));
    return (response.Buckets ?? [])
      .filter((b) => b.Name)
      .map((b) => ({ name: b.Name!, createdAt: b.CreationDate?.toISOString() ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(bucket: string, prefix: string, token?: string): Promise<S3ListResult> {
    const response = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        Delimiter: '/',
        MaxKeys: 1000,
        ContinuationToken: token || undefined,
      }),
    );
    return {
      bucket,
      prefix,
      folders: (response.CommonPrefixes ?? []).map((p) => p.Prefix ?? '').filter(Boolean),
      objects: (response.Contents ?? [])
        .filter((o) => o.Key && o.Key !== prefix)
        .map((o) => ({
          key: o.Key!,
          size: o.Size ?? 0,
          lastModified: o.LastModified?.toISOString() ?? null,
          etag: o.ETag?.replaceAll('"', '') ?? null,
          storageClass: o.StorageClass ?? null,
        })),
      nextToken: response.IsTruncated ? (response.NextContinuationToken ?? null) : null,
    };
  }

  async object(bucket: string, key: string): Promise<S3ObjectDetail> {
    const head = await this.s3
      .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      .catch((error) => {
        throw describe(error, `object "${key}"`);
      });
    const tags = await this.s3
      .send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }))
      .then((r) => Object.fromEntries((r.TagSet ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])))
      .catch(() => null);
    return {
      key,
      size: head.ContentLength ?? 0,
      lastModified: head.LastModified?.toISOString() ?? null,
      etag: head.ETag?.replaceAll('"', '') ?? null,
      storageClass: head.StorageClass ?? null,
      contentType: head.ContentType ?? null,
      metadata: head.Metadata ?? {},
      cacheControl: head.CacheControl ?? null,
      versionId: head.VersionId ?? null,
      tags,
    };
  }

  async download(
    bucket: string,
    key: string,
  ): Promise<{ body: Readable; size: number | null; contentType: string | null }> {
    const response = await this.s3
      .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      .catch((error) => {
        throw describe(error, `object "${key}"`);
      });
    return {
      body: response.Body as Readable,
      size: response.ContentLength ?? null,
      contentType: response.ContentType ?? null,
    };
  }

  async upload(
    bucket: string,
    key: string,
    body: Readable | Buffer,
    size: number,
    contentType: string | null,
  ): Promise<void> {
    this.requireWrite();
    if (!key || key.endsWith('/')) throw new ExploreError('choose a file name');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: size,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  /** An empty "folder/" marker, as consoles create them. */
  async createFolder(bucket: string, prefix: string): Promise<void> {
    this.requireWrite();
    const key = prefix.endsWith('/') ? prefix : `${prefix}/`;
    await this.s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: '', ContentLength: 0 }),
    );
  }

  /** Deletes the keys, or everything under a prefix. Returns how many objects went. */
  async remove(bucket: string, keys: string[], prefix?: string): Promise<number> {
    this.requireWrite();
    let targets = keys;
    if (prefix) {
      if (prefix === '' || prefix === '/')
        throw new ExploreError('to empty a whole bucket, delete the bucket');
      targets = [];
      let token: string | undefined;
      do {
        const page = await this.s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        targets.push(...(page.Contents ?? []).map((o) => o.Key!).filter(Boolean));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (targets.length > 100_000)
          throw new ExploreError('more than 100,000 objects: use a lifecycle rule instead');
      } while (token);
    }
    let removed = 0;
    for (let i = 0; i < targets.length; i += 1000) {
      const batch = targets.slice(i, i + 1000);
      const result = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (result.Errors && result.Errors.length > 0) {
        throw new ExploreError(
          `could not delete ${result.Errors.length} object(s): ${result.Errors[0]?.Message ?? 'error'}`,
        );
      }
      removed += batch.length;
    }
    return removed;
  }

  /** Copies (or moves) one object inside a bucket. */
  async copy(bucket: string, from: string, to: string, move: boolean): Promise<void> {
    this.requireWrite();
    if (!to || to === from) throw new ExploreError('choose a different name');
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: to,
        CopySource: `${bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
      }),
    );
    if (move) await this.remove(bucket, [from]);
  }

  async setTags(bucket: string, key: string, tags: Record<string, string>): Promise<void> {
    this.requireWrite();
    await this.s3.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: key,
        Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
      }),
    );
  }

  async settings(bucket: string): Promise<S3BucketSettings> {
    const notes: string[] = [];
    const read = async <T>(
      what: string,
      run: () => Promise<T>,
      absent: (error: unknown) => boolean,
    ): Promise<T | null> => {
      try {
        return await run();
      } catch (error) {
        const described = describe(error, what);
        // Not supported by this storage (MinIO, R2…) is not a problem worth a warning.
        if (!absent(error) && described.status !== 501) notes.push(`${what}: ${described.message}`);
        return null;
      }
    };
    const missing =
      (...names: string[]) =>
      (error: unknown) =>
        names.includes((error as { name?: string }).name ?? '');
    const region = await read(
      'region',
      async () =>
        (await this.s3.send(new GetBucketLocationCommand({ Bucket: bucket }))).LocationConstraint ||
        'us-east-1',
      () => false,
    );
    const versioning = await read(
      'versioning',
      async () =>
        (await this.s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status ?? 'Off',
      () => false,
    );
    const policy = await read(
      'policy',
      async () => {
        const text =
          (await this.s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))).Policy ?? null;
        return text ? JSON.stringify(JSON.parse(text), null, 2) : null;
      },
      missing('NoSuchBucketPolicy'),
    );
    const cors = await read(
      'CORS',
      async () =>
        JSON.stringify(
          (await this.s3.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules ?? [],
          null,
          2,
        ),
      missing('NoSuchCORSConfiguration'),
    );
    const lifecycle = await read(
      'lifecycle',
      async () =>
        JSON.stringify(
          (await this.s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })))
            .Rules ?? [],
          null,
          2,
        ),
      missing('NoSuchLifecycleConfiguration'),
    );
    const publicAccessBlock = await read(
      'public access block',
      async () => {
        const c = (await this.s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket })))
          .PublicAccessBlockConfiguration;
        return c
          ? {
              BlockPublicAcls: c.BlockPublicAcls === true,
              IgnorePublicAcls: c.IgnorePublicAcls === true,
              BlockPublicPolicy: c.BlockPublicPolicy === true,
              RestrictPublicBuckets: c.RestrictPublicBuckets === true,
            }
          : null;
      },
      missing('NoSuchPublicAccessBlockConfiguration'),
    );
    const acl = await read(
      'ACL',
      async () =>
        ((await this.s3.send(new GetBucketAclCommand({ Bucket: bucket }))).Grants ?? []).map(
          (g) => ({
            grantee:
              g.Grantee?.DisplayName ??
              g.Grantee?.URI?.replace(/^.*\//, '') ??
              g.Grantee?.ID ??
              g.Grantee?.EmailAddress ??
              'unknown',
            permission: g.Permission ?? '',
          }),
        ),
      () => false,
    );
    const encryption = await read(
      'encryption',
      async () => {
        const rules = (await this.s3.send(new GetBucketEncryptionCommand({ Bucket: bucket })))
          .ServerSideEncryptionConfiguration?.Rules;
        return (
          rules
            ?.map((r) => r.ApplyServerSideEncryptionByDefault?.SSEAlgorithm)
            .filter(Boolean)
            .join(', ') || null
        );
      },
      missing('ServerSideEncryptionConfigurationNotFoundError'),
    );
    return {
      region,
      versioning,
      policy,
      cors,
      lifecycle,
      publicAccessBlock,
      acl,
      encryption,
      notes,
    };
  }

  async setPolicy(bucket: string, policy: string | null): Promise<void> {
    this.requireWrite();
    if (policy === null || policy.trim() === '') {
      await this.s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
      return;
    }
    try {
      JSON.parse(policy);
    } catch (error) {
      throw new ExploreError(`the policy is not valid JSON: ${(error as Error).message}`);
    }
    await this.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy }));
  }

  async setCors(bucket: string, rules: string | null): Promise<void> {
    this.requireWrite();
    if (rules === null || rules.trim() === '' || rules.trim() === '[]') {
      await this.s3.send(new DeleteBucketCorsCommand({ Bucket: bucket }));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rules);
    } catch (error) {
      throw new ExploreError(`the CORS rules are not valid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new ExploreError('CORS rules must be a JSON array');
    await this.s3.send(
      new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: parsed } }),
    );
  }

  async setVersioning(bucket: string, enabled: boolean): Promise<void> {
    this.requireWrite();
    await this.s3.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: enabled ? 'Enabled' : 'Suspended' },
      }),
    );
  }

  async createBucket(bucket: string): Promise<void> {
    this.requireWrite();
    const region = this.config.region;
    await this.s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(this.config.provider === 'aws' && region && region !== 'us-east-1'
          ? { CreateBucketConfiguration: { LocationConstraint: region as never } }
          : {}),
      }),
    );
  }

  async deleteBucket(bucket: string): Promise<void> {
    this.requireWrite();
    await this.s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch((error) => {
      if ((error as { name?: string }).name === 'BucketNotEmpty') {
        throw new ExploreError('the bucket is not empty: delete its objects first', 409);
      }
      throw error;
    });
  }

  /** Size per top-level folder (counting stops at a limit on huge buckets). */
  async usage(bucket: string): Promise<S3UsageResult> {
    const byPrefix = new Map<string, { objects: number; bytes: number }>();
    let totalObjects = 0;
    let totalBytes = 0;
    let token: string | undefined;
    let capped = false;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 }),
      );
      for (const object of page.Contents ?? []) {
        const key = object.Key ?? '';
        const slash = key.indexOf('/');
        const prefix = slash >= 0 ? key.slice(0, slash + 1) : '(root files)';
        const entry = byPrefix.get(prefix) ?? { objects: 0, bytes: 0 };
        entry.objects += 1;
        entry.bytes += object.Size ?? 0;
        byPrefix.set(prefix, entry);
        totalObjects += 1;
        totalBytes += object.Size ?? 0;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (token && totalObjects >= USAGE_OBJECT_LIMIT) {
        capped = true;
        token = undefined;
      }
    } while (token);
    return {
      bucket,
      byPrefix: [...byPrefix.entries()]
        .map(([prefix, v]) => ({ prefix, ...v }))
        .sort((a, b) => b.bytes - a.bytes),
      totalObjects,
      totalBytes,
      capped,
    };
  }

  async close() {
    this.s3.destroy();
  }
}

function describe(error: unknown, what: string): ExploreError {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const name = (error as { name?: string }).name;
  if (status === 404 || name === 'NotFound' || name === 'NoSuchKey')
    return new ExploreError(`${what} not found`, 404);
  if (status === 403 || name === 'AccessDenied')
    return new ExploreError(`access denied to ${what}: the keys lack this permission`, 403);
  if (status === 501 || name === 'NotImplemented')
    return new ExploreError(`this storage does not support ${what}`, 501);
  return new ExploreError(
    errorMessage(error),
    status && status >= 400 && status < 600 ? status : 502,
  );
}
