import {
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { Resource } from '@app/shared';
import type { ResourceConfigOf } from '../config/resources-file';
import {
  awsCredentials,
  errorMessage,
  healthSample,
  metric,
  redactSecrets,
  type Connector,
  type ConnectorContext,
  type PollOutcome,
} from './connector';

const PROVIDER_LABELS: Record<ResourceConfigOf<'s3'>['provider'], string> = {
  aws: 'AWS',
  spaces: 'Spaces',
  minio: 'MinIO',
  r2: 'R2',
  other: 'compatible',
};

/** Growth is measured over (at most) this window of earlier polls. */
const GROWTH_WINDOW_MS = 60 * 60_000;

/**
 * S3-compatible object storage (AWS S3, DigitalOcean Spaces, MinIO,
 * Cloudflare R2) via `@aws-sdk/client-s3` with a custom endpoint. Only
 * ListBuckets, HeadBucket and ListObjectsV2: nothing is read or written
 * inside objects. Counting stops at `maxObjects`; past that the count and
 * size are shown as "at least", and growth is unknown.
 */
export function createS3Connector(
  config: ResourceConfigOf<'s3'>,
  context: ConnectorContext,
  client?: S3Client,
): Connector {
  const s3 = client ?? new S3Client(clientConfig(config, context));
  const providerLabel = PROVIDER_LABELS[config.provider];
  const district = config.district ?? `Object storage`;
  let known: Resource[] = [];
  const sizeHistory = new Map<string, { at: number; bytes: number }[]>();

  const toResource = (bucket: string): Resource => ({
    id: `${config.id}-${slug(bucket)}`,
    name: bucket,
    kind: 's3',
    engine: `S3 · ${providerLabel}`,
    district,
    tags: config.tags,
    target: config.endpoint ? new URL(config.endpoint).host : `s3.${config.region}.amazonaws.com`,
    sourceId: config.id,
    dependsOn: config.dependsOn,
  });

  const placeholder = (): Resource => ({
    ...toResource(config.id),
    id: config.id,
    name: config.name ?? config.id,
  });

  const listBuckets = async (): Promise<string[]> => {
    if (config.buckets) return [...config.buckets].sort();
    const response = await s3.send(new ListBucketsCommand({}));
    return (response.Buckets ?? [])
      .map((bucket) => bucket.Name ?? '')
      .filter(Boolean)
      .sort();
  };

  const measure = async (bucket: string, resource: Resource): Promise<PollOutcome> => {
    try {
      const started = performance.now();
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      const latencyMs = performance.now() - started;
      let objects = 0;
      let bytes = 0;
      let capped = false;
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: token,
            MaxKeys: Math.min(1000, config.maxObjects - objects),
          }),
        );
        for (const object of page.Contents ?? []) {
          objects += 1;
          bytes += object.Size ?? 0;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (token && objects >= config.maxObjects) {
          capped = true;
          token = undefined;
        }
      } while (token);

      const now = context.now();
      const growth = capped ? null : recordGrowth(sizeHistory, resource.id, now, bytes);
      return {
        resourceId: resource.id,
        ok: true,
        sample: healthSample({
          storage: { usedBytes: bytes, totalBytes: null },
          growthBytesPerHour: growth,
        }),
        metrics: [
          metric('objects', 'Objects', 'count', objects, capped),
          metric('size', 'Size', 'bytes', bytes, capped),
          metric('growth', 'Growth', 'bytesPerHour', growth),
          metric('latency', 'HeadBucket latency', 'ms', Math.round(latencyMs)),
        ],
      };
    } catch (error) {
      return { resourceId: resource.id, ok: false, error: redactSecrets(describeS3Error(error)) };
    }
  };

  const poll = async (): Promise<PollOutcome[]> => {
    let buckets: string[];
    try {
      buckets = await listBuckets();
    } catch (error) {
      if (known.length === 0) known = [placeholder()];
      const message = `cannot list buckets: ${redactSecrets(describeS3Error(error))}`;
      return known.map((resource) => ({ resourceId: resource.id, ok: false, error: message }));
    }
    known = buckets.map(toResource);
    const outcomes: PollOutcome[] = [];
    // One bucket at a time: listing is the expensive part and providers rate-limit it.
    for (const [index, bucket] of buckets.entries())
      outcomes.push(await measure(bucket, known[index]!));
    return outcomes;
  };

  return {
    config,
    resources: () => (known.length > 0 ? known : [placeholder()]),
    poll,
    close: async () => s3.destroy(),
  };
}

function clientConfig(config: ResourceConfigOf<'s3'>, context: ConnectorContext): S3ClientConfig {
  const credentials = awsCredentials(config, context);
  const region = config.provider === 'r2' && config.region === 'us-east-1' ? 'auto' : config.region;
  return {
    region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle ?? config.provider === 'minio',
    ...(config.profile ? { profile: config.profile } : {}),
    // Keys typed in the app or named by environment variables; otherwise the standard AWS chain.
    ...(credentials ? { credentials } : {}),
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

/** Bytes per hour from the oldest sample inside the window; null until two polls exist. */
export function recordGrowth(
  history: Map<string, { at: number; bytes: number }[]>,
  id: string,
  now: number,
  bytes: number,
): number | null {
  const samples = (history.get(id) ?? []).filter((sample) => now - sample.at <= GROWTH_WINDOW_MS);
  samples.push({ at: now, bytes });
  history.set(id, samples);
  const oldest = samples[0]!;
  if (samples.length < 2 || now <= oldest.at) return null;
  return ((bytes - oldest.bytes) / (now - oldest.at)) * 3_600_000;
}

function describeS3Error(error: unknown): string {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const name = (error as { name?: string }).name;
  if (status === 403) return 'access denied (403): check the key or bucket policy';
  if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket')
    return 'bucket not found (404)';
  if (status === 301) return 'wrong region or endpoint (301)';
  return errorMessage(error);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '') || 'x'
  );
}
