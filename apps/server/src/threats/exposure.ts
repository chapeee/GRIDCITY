import { DescribeSecurityGroupsCommand, EC2Client, type SecurityGroup } from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand, type DBInstance } from '@aws-sdk/client-rds';
import {
  GetBucketAclCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Resource, ThreatCoverage } from '@app/shared';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import type { ResourceConfig, ResourceConfigOf } from '../config/resources-file';
import {
  awsCredentials,
  errorMessage,
  tlsOptions,
  type ConnectorContext,
} from '../connectors/connector';
import { createRdsClients } from '../connectors/rds';
import { clientConfig } from '../connectors/s3';
import type { ThreatDraft } from './detect';

/** What one exposure round found for one resource. */
export interface ResourceExposure {
  targetId: string;
  drafts: ThreatDraft[];
  checkedScopes: string[];
  coverage: ThreatCoverage['checks'];
}

/** Talking to cloud APIs and databases; injectable for tests. */
export interface ExposureProbes {
  bucket(config: ResourceConfigOf<'s3'>, bucket: string): Promise<BucketFacts>;
  rds(
    config: ResourceConfigOf<'rds'>,
  ): Promise<{ instances: DBInstance[]; groups: SecurityGroup[] }>;
  /** True when Redis answers PING with no password at all. */
  redisOpen(config: ResourceConfigOf<'redis'>): Promise<boolean>;
  /** True when MongoDB lists databases with no credentials. */
  mongoOpen(config: ResourceConfigOf<'mongodb'>): Promise<boolean>;
}

export interface BucketFacts {
  /** null when the provider does not support the call (MinIO, R2, LocalStack). */
  blockAll: boolean | null;
  policyPublic: boolean | null;
  aclPublic: boolean | null;
}

const PUBLIC_GROUPS = [
  'http://acs.amazonaws.com/groups/global/AllUsers',
  'http://acs.amazonaws.com/groups/global/AuthenticatedUsers',
];

/** Read-only checks with the credentials GRIDCITY already has. */
export const defaultProbes = (context: ConnectorContext): ExposureProbes => ({
  async bucket(config, bucket) {
    const s3 = new S3Client(clientConfig(config, context));
    try {
      const unsupported = (error: unknown) => {
        const name = (error as { name?: string }).name ?? '';
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        return name === 'NotImplemented' || status === 501 || name === 'MethodNotAllowed';
      };
      const missing = (error: unknown, ...names: string[]) =>
        names.includes((error as { name?: string }).name ?? '');

      let blockAll: boolean | null = null;
      try {
        const block = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
        const c = block.PublicAccessBlockConfiguration;
        blockAll = Boolean(
          c?.BlockPublicAcls &&
          c.IgnorePublicAcls &&
          c.BlockPublicPolicy &&
          c.RestrictPublicBuckets,
        );
      } catch (error) {
        if (missing(error, 'NoSuchPublicAccessBlockConfiguration')) blockAll = false;
        else if (!unsupported(error)) throw error;
      }

      let policyPublic: boolean | null = null;
      try {
        const status = await s3.send(new GetBucketPolicyStatusCommand({ Bucket: bucket }));
        policyPublic = Boolean(status.PolicyStatus?.IsPublic);
      } catch (error) {
        if (missing(error, 'NoSuchBucketPolicy')) policyPublic = false;
        else if (!unsupported(error)) throw error;
      }
      if (policyPublic === null || policyPublic === false) {
        // Providers without PolicyStatus: read the policy and look for an unconditioned "*".
        try {
          const policy = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
          policyPublic = policyGrantsEveryone(policy.Policy ?? '');
        } catch (error) {
          if (missing(error, 'NoSuchBucketPolicy')) policyPublic ??= false;
          else if (!unsupported(error)) throw error;
        }
      }

      let aclPublic: boolean | null = null;
      try {
        const acl = await s3.send(new GetBucketAclCommand({ Bucket: bucket }));
        aclPublic = (acl.Grants ?? []).some((grant) =>
          PUBLIC_GROUPS.includes(grant.Grantee?.URI ?? ''),
        );
      } catch (error) {
        if (!unsupported(error)) throw error;
      }
      return { blockAll, policyPublic, aclPublic };
    } finally {
      s3.destroy();
    }
  },

  async rds(config) {
    const { rds, cloudWatch } = createRdsClients(config, context);
    cloudWatch.destroy();
    try {
      const response = await rds.send(new DescribeDBInstancesCommand({}));
      const instances = (response.DBInstances ?? []).filter(
        (instance) =>
          !config.instances || config.instances.includes(instance.DBInstanceIdentifier ?? ''),
      );
      const groupIds = [
        ...new Set(
          instances.flatMap((i) =>
            (i.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId ?? ''),
          ),
        ),
      ].filter(Boolean);
      if (groupIds.length === 0) return { instances, groups: [] };
      const credentials = awsCredentials(config, context);
      const ec2 = new EC2Client({
        region: config.region,
        ...(credentials ? { credentials } : {}),
        ...(config.profile ? { profile: config.profile } : {}),
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        maxAttempts: 2,
      });
      try {
        const groups = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: groupIds }));
        return { instances, groups: groups.SecurityGroups ?? [] };
      } catch {
        // No ec2:DescribeSecurityGroups permission: PubliclyAccessible is still known.
        return { instances, groups: [] };
      } finally {
        ec2.destroy();
      }
    } finally {
      rds.destroy();
    }
  },

  async redisOpen(config) {
    const client = new Redis({
      host: config.host,
      port: config.port,
      tls: tlsOptions(config),
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 5000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      return (await client.ping()) === 'PONG';
    } catch {
      return false; // NOAUTH, refused or protected mode: not open
    } finally {
      client.disconnect();
    }
  },

  async mongoOpen(config) {
    const url = config.url.replace(/\/\/[^@/]*@/, '//');
    const client = new MongoClient(url, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      directConnection: !url.startsWith('mongodb+srv') && !/replicaSet=/.test(url),
      ...(config.tls ? { tls: true } : {}),
    });
    try {
      await client.connect();
      await client.db('admin').command({ listDatabases: 1, nameOnly: true });
      return true;
    } catch {
      return false;
    } finally {
      await client.close().catch(() => undefined);
    }
  },
});

/** A bucket policy statement that allows "*" without any condition. */
export function policyGrantsEveryone(policy: string): boolean {
  if (!policy) return false;
  try {
    const parsed = JSON.parse(policy) as { Statement?: unknown };
    const statements = Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement];
    return statements.some((raw) => {
      const statement = raw as { Effect?: string; Principal?: unknown; Condition?: unknown };
      if (statement?.Effect !== 'Allow' || statement.Condition) return false;
      const principal = statement.Principal;
      if (principal === '*') return true;
      const aws = (principal as { AWS?: unknown } | undefined)?.AWS;
      return aws === '*' || (Array.isArray(aws) && aws.includes('*'));
    });
  } catch {
    return false;
  }
}

/**
 * Exposure checks for every live resource: public buckets, databases reachable
 * from the internet, Redis and MongoDB that need no password. Each resource
 * says which checks ran; a check that could not run never resolves anything.
 */
export async function checkExposure(
  resources: readonly Resource[],
  configs: ReadonlyMap<string, ResourceConfig>,
  probes: ExposureProbes,
  now: number,
): Promise<ResourceExposure[]> {
  const results: ResourceExposure[] = [];
  const draft = (
    over: Partial<ThreatDraft> &
      Pick<ThreatDraft, 'key' | 'title' | 'detail' | 'advice' | 'severity'>,
  ): ThreatDraft => ({
    scope: 'exposure',
    source: 'builtin',
    category: 'exposure',
    attackerIp: null,
    count: 1,
    firstSeen: now,
    lastSeen: now,
    blocked: null,
    ...over,
  });

  const rdsBySource = new Map<
    string,
    Promise<{ instances: DBInstance[]; groups: SecurityGroup[] }>
  >();

  for (const resource of resources) {
    const config = configs.get(resource.sourceId);
    if (!config) continue;
    const result: ResourceExposure = {
      targetId: resource.id,
      drafts: [],
      checkedScopes: [],
      coverage: [],
    };
    try {
      if (config.kind === 's3' && resource.id !== config.id) {
        const facts = await probes.bucket(config, resource.name);
        result.checkedScopes.push('exposure');
        const publicBy = [
          facts.policyPublic ? 'its bucket policy allows everyone' : '',
          facts.aclPublic && facts.blockAll !== true ? 'its ACL grants access to all users' : '',
        ].filter(Boolean);
        if (publicBy.length > 0) {
          result.drafts.push(
            draft({
              key: 'public-bucket',
              severity: 'high',
              title: `Bucket ${resource.name} is public`,
              detail: `Anyone on the internet can read objects in this bucket: ${publicBy.join(' and ')}.`,
              advice:
                'Unless it serves a public website, turn on "Block all public access" and remove the "*" statement from the bucket policy (Manage → Settings).',
            }),
          );
        } else if (facts.blockAll === false && config.provider === 'aws') {
          result.drafts.push(
            draft({
              key: 'no-public-access-block',
              severity: 'low',
              title: `Bucket ${resource.name} has no public access block`,
              detail:
                'Nothing is public now, but "Block public access" is off, so one policy or ACL change could expose it.',
              advice:
                'Turn on all four "Block public access" settings unless the bucket must be public.',
            }),
          );
        }
        result.coverage.push({
          name: 'Public access',
          ok: true,
          note: facts.blockAll === null ? 'this provider has no public access block' : null,
        });
      } else if (config.kind === 'rds' && resource.id !== config.id) {
        let pending = rdsBySource.get(config.id);
        if (!pending) {
          pending = probes.rds(config);
          rdsBySource.set(config.id, pending);
        }
        const { instances, groups } = await pending;
        const instance = instances.find((i) => i.DBInstanceIdentifier === resource.name);
        if (instance) {
          result.checkedScopes.push('exposure');
          const port = instance.Endpoint?.Port ?? 0;
          const open = openToWorld(
            groups,
            (instance.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId ?? ''),
            port,
          );
          if (instance.PubliclyAccessible && open.length > 0) {
            result.drafts.push(
              draft({
                key: 'public-database',
                severity: 'high',
                title: `${resource.name} is reachable from the whole internet`,
                detail: `The instance is publicly accessible and security group ${open.join(', ')} allows port ${port} from anywhere (0.0.0.0/0). Databases like this are scanned and brute-forced within minutes.`,
                advice:
                  'Restrict the security group to your application servers or VPN, or turn off "Publicly accessible".',
              }),
            );
          } else if (instance.PubliclyAccessible) {
            result.drafts.push(
              draft({
                key: 'publicly-accessible',
                severity: 'medium',
                title: `${resource.name} is publicly accessible`,
                detail: `RDS gives this instance a public address${groups.length === 0 ? '; its security groups could not be read' : ', though no security group opens it to everyone'}.`,
                advice:
                  'Turn off "Publicly accessible" unless something outside the VPC must reach it.',
              }),
            );
          }
          result.coverage.push({
            name: 'Internet exposure',
            ok: true,
            note:
              groups.length === 0
                ? 'security groups not readable (ec2:DescribeSecurityGroups)'
                : null,
          });
        }
      } else if (config.kind === 'redis') {
        result.checkedScopes.push('exposure');
        if (await probes.redisOpen(config)) {
          result.drafts.push(
            draft({
              key: 'redis-no-auth',
              severity: 'high',
              title: `${resource.name} answers without a password`,
              detail: `Redis at ${config.host}:${config.port} runs commands for anyone who can reach it. Open Redis servers are a favourite way into machines (writing SSH keys, cron jobs or modules).`,
              advice:
                'Set a password (requirepass or ACL users), bind it to a private address, and turn protected mode on.',
            }),
          );
        }
        result.coverage.push({ name: 'Password', ok: true, note: null });
      } else if (config.kind === 'mongodb') {
        result.checkedScopes.push('exposure');
        if (await probes.mongoOpen(config)) {
          result.drafts.push(
            draft({
              key: 'mongo-no-auth',
              severity: 'high',
              title: `${resource.name} lets anyone list its databases`,
              detail:
                'MongoDB accepted a connection without credentials and listed its databases. Unprotected MongoDB servers are wiped and held for ransom by bots.',
              advice:
                'Turn on authorization (security.authorization: enabled), create users, and bind it to a private address.',
            }),
          );
        }
        result.coverage.push({ name: 'Authentication', ok: true, note: null });
      } else {
        continue;
      }
    } catch (error) {
      result.coverage.push({
        name: 'Exposure',
        ok: false,
        note: errorMessage(error).slice(0, 200),
      });
    }
    results.push(result);
  }
  return results;
}

/** Security groups of an instance that open its port to 0.0.0.0/0 or ::/0. */
export function openToWorld(
  groups: readonly SecurityGroup[],
  groupIds: readonly string[],
  port: number,
): string[] {
  return groups
    .filter((group) => groupIds.includes(group.GroupId ?? ''))
    .filter((group) =>
      (group.IpPermissions ?? []).some((rule) => {
        const everyone =
          (rule.IpRanges ?? []).some((range) => range.CidrIp === '0.0.0.0/0') ||
          (rule.Ipv6Ranges ?? []).some((range) => range.CidrIpv6 === '::/0');
        if (!everyone) return false;
        if (rule.IpProtocol === '-1') return true;
        const from = rule.FromPort ?? 0;
        const to = rule.ToPort ?? 65535;
        return port >= from && port <= to;
      }),
    )
    .map((group) => `${group.GroupName ?? group.GroupId}`);
}
