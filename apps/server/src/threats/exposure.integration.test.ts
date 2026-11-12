/**
 * Exposure checks against REAL instances (compose.connectors-test.yaml):
 * a MinIO bucket made public with an anonymous-read policy, and the test
 * Redis and MongoDB, which require passwords. Run with `npm run test:connectors`.
 */
import {
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ResourceConfigSchema, type ResourceConfig } from '../config/resources-file';
import { checkExposure, defaultProbes } from './exposure';

const enabled = process.env.CONNECTOR_TESTS === '1';
const env = {
  MINIO_KEY: 'test-minio',
  MINIO_SECRET: 'test-minio-secret',
  REDIS_MONITOR: 'test-monitor',
};
const context = { env, homeDir: tmpdir(), appName: 'exposure-tests', now: Date.now };
const parse = (raw: unknown) => ResourceConfigSchema.parse(raw) as ResourceConfig;

describe.skipIf(!enabled)('exposure checks (real instances)', () => {
  it('finds a public MinIO bucket, and stops reporting it once the policy is gone', async () => {
    const config = parse({
      kind: 's3',
      id: 'minio',
      provider: 'minio',
      endpoint: 'http://127.0.0.1:19000',
      accessKeyIdEnv: 'MINIO_KEY',
      secretAccessKeyEnv: 'MINIO_SECRET',
    });
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:19000',
      forcePathStyle: true,
      credentials: { accessKeyId: env.MINIO_KEY, secretAccessKey: env.MINIO_SECRET },
    });
    const bucket = `exposed-${Date.now()}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${bucket}/*`],
            },
          ],
        }),
      }),
    );
    const resource = {
      id: `minio-${bucket}`,
      name: bucket,
      kind: 's3' as const,
      engine: 'S3',
      district: 'D',
      tags: [],
      target: 't',
      sourceId: 'minio',
    };
    const configs = new Map([['minio', config]]);
    const [open] = await checkExposure([resource], configs, defaultProbes(context), Date.now());
    expect(open!.drafts.map((d) => d.key)).toEqual(['public-bucket']);

    await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    const [closed] = await checkExposure([resource], configs, defaultProbes(context), Date.now());
    expect(closed!.checkedScopes).toEqual(['exposure']);
    expect(closed!.drafts).toEqual([]);
    s3.destroy();
  });

  it('sees that the test Redis and MongoDB require a password', async () => {
    const configs = new Map<string, ResourceConfig>([
      [
        'cache',
        parse({
          kind: 'redis',
          id: 'cache',
          host: '127.0.0.1',
          port: 16379,
          user: 'monitor',
          passwordEnv: 'REDIS_MONITOR',
        }),
      ],
      [
        'events',
        parse({
          kind: 'mongodb',
          id: 'events',
          url: 'mongodb://monitor@127.0.0.1:27018/?authSource=admin',
        }),
      ],
    ]);
    const resources = [
      {
        id: 'cache',
        name: 'Cache',
        kind: 'redis' as const,
        engine: 'Redis',
        district: 'D',
        tags: [],
        target: 't',
        sourceId: 'cache',
      },
      {
        id: 'events',
        name: 'Events',
        kind: 'mongodb' as const,
        engine: 'MongoDB',
        district: 'D',
        tags: [],
        target: 't',
        sourceId: 'events',
      },
    ];
    const results = await checkExposure(resources, configs, defaultProbes(context), Date.now());
    expect(results.map((r) => [r.targetId, r.checkedScopes, r.drafts.length])).toEqual([
      ['cache', ['exposure'], 0],
      ['events', ['exposure'], 0],
    ]);
  });
});
