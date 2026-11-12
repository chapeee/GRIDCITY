import type { Resource } from '@app/shared';
import { describe, expect, it } from 'vitest';
import type { ResourceConfig } from '../config/resources-file';
import { checkExposure, openToWorld, policyGrantsEveryone, type ExposureProbes } from './exposure';

const resource = (
  id: string,
  sourceId: string,
  name: string,
  kind: Resource['kind'],
): Resource => ({
  id,
  name,
  kind,
  engine: kind,
  district: 'D',
  tags: [],
  target: 't',
  sourceId,
});

const configs = new Map<string, ResourceConfig>([
  [
    'media',
    { kind: 's3', id: 'media', provider: 'aws', region: 'us-east-1' } as unknown as ResourceConfig,
  ],
  [
    'minio',
    {
      kind: 's3',
      id: 'minio',
      provider: 'minio',
      region: 'us-east-1',
    } as unknown as ResourceConfig,
  ],
  ['aws-db', { kind: 'rds', id: 'aws-db', region: 'eu-west-1' } as unknown as ResourceConfig],
  ['cache', { kind: 'redis', id: 'cache', host: 'h', port: 6379 } as unknown as ResourceConfig],
  [
    'events',
    { kind: 'mongodb', id: 'events', url: 'mongodb://h:27017' } as unknown as ResourceConfig,
  ],
]);

const probes = (over: Partial<ExposureProbes> = {}): ExposureProbes => ({
  bucket: async (_config, bucket) =>
    bucket === 'site'
      ? { blockAll: false, policyPublic: true, aclPublic: false }
      : bucket === 'loose'
        ? { blockAll: false, policyPublic: false, aclPublic: false }
        : { blockAll: null, policyPublic: false, aclPublic: false },
  rds: async () => ({
    instances: [
      {
        DBInstanceIdentifier: 'orders',
        PubliclyAccessible: true,
        Endpoint: { Port: 5432 },
        VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-1' }],
      },
      {
        DBInstanceIdentifier: 'users',
        PubliclyAccessible: false,
        Endpoint: { Port: 3306 },
        VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-2' }],
      },
    ],
    groups: [
      {
        GroupId: 'sg-1',
        GroupName: 'db-open',
        IpPermissions: [
          { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
        ],
      },
      {
        GroupId: 'sg-2',
        GroupName: 'db-private',
        IpPermissions: [
          { IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
        ],
      },
    ],
  }),
  redisOpen: async () => true,
  mongoOpen: async () => false,
  ...over,
});

describe('exposure checks', () => {
  it('finds public buckets, internet-facing databases and Redis without a password', async () => {
    const results = await checkExposure(
      [
        resource('media-site', 'media', 'site', 's3'),
        resource('media-loose', 'media', 'loose', 's3'),
        resource('minio-files', 'minio', 'files', 's3'),
        resource('aws-db-orders', 'aws-db', 'orders', 'rds'),
        resource('aws-db-users', 'aws-db', 'users', 'rds'),
        resource('cache', 'cache', 'Cache', 'redis'),
        resource('events', 'events', 'Events', 'mongodb'),
      ],
      configs,
      probes(),
      1000,
    );
    const found = Object.fromEntries(
      results.map((r) => [r.targetId, r.drafts.map((d) => `${d.key}=${d.severity}`)]),
    );
    expect(found).toEqual({
      'media-site': ['public-bucket=high'],
      'media-loose': ['no-public-access-block=low'],
      'minio-files': [],
      'aws-db-orders': ['public-database=high'],
      'aws-db-users': [],
      cache: ['redis-no-auth=high'],
      events: [],
    });
    expect(results.every((r) => r.checkedScopes.includes('exposure'))).toBe(true);
    expect(results.find((r) => r.targetId === 'minio-files')!.coverage[0]!.note).toMatch(
      /no public access block/,
    );
  });

  it('reports a check that failed without resolving anything', async () => {
    const [result] = await checkExposure(
      [resource('media-site', 'media', 'site', 's3')],
      configs,
      probes({
        bucket: async () => {
          throw new Error('AccessDenied: s3:GetBucketPolicy');
        },
      }),
      1000,
    );
    expect(result!.checkedScopes).toEqual([]);
    expect(result!.coverage[0]).toMatchObject({
      ok: false,
      note: 'AccessDenied: s3:GetBucketPolicy',
    });
  });

  it('reads bucket policies and security groups the way AWS means them', () => {
    expect(
      policyGrantsEveryone(
        JSON.stringify({
          Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject' }],
        }),
      ),
    ).toBe(true);
    expect(
      policyGrantsEveryone(
        JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] } }] }),
      ),
    ).toBe(true);
    expect(
      policyGrantsEveryone(
        JSON.stringify({
          Statement: [
            {
              Effect: 'Allow',
              Principal: '*',
              Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } },
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      policyGrantsEveryone(JSON.stringify({ Statement: { Effect: 'Deny', Principal: '*' } })),
    ).toBe(false);
    expect(policyGrantsEveryone('not json')).toBe(false);
    expect(
      openToWorld(
        [
          {
            GroupId: 'a',
            IpPermissions: [{ IpProtocol: '-1', Ipv6Ranges: [{ CidrIpv6: '::/0' }] }],
          },
        ],
        ['a'],
        5432,
      ),
    ).toEqual(['a']);
    expect(
      openToWorld(
        [
          {
            GroupId: 'a',
            IpPermissions: [
              { IpProtocol: 'tcp', FromPort: 80, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
            ],
          },
        ],
        ['a'],
        5432,
      ),
    ).toEqual([]);
  });
});
