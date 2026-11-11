import { z } from 'zod';
import type { HostStatus } from './host-state';

/**
 * A district is a place in the city that holds anything: servers, databases,
 * managed instances, buckets, load balancers and probes side by side, exactly
 * like a VPC or a provider account holds EC2 instances next to their RDS and
 * S3. Hosts and resources name their district with the plain `district`
 * label; this record adds what the label alone cannot say (provider, region,
 * a description). It comes from districts.yaml, and every label that has no
 * entry there becomes an inferred district with just its name.
 */
export const DistrictProviderSchema = z.enum([
  'aws',
  'gcp',
  'azure',
  'digitalocean',
  'hetzner',
  'oracle',
  'cloudflare',
  'ovh',
  'linode',
  'vultr',
  'home',
  'onprem',
  'other',
]);
export type DistrictProvider = z.infer<typeof DistrictProviderSchema>;

export const DISTRICT_PROVIDER_LABELS: Record<DistrictProvider, string> = {
  aws: 'AWS',
  gcp: 'Google Cloud',
  azure: 'Azure',
  digitalocean: 'DigitalOcean',
  hetzner: 'Hetzner',
  oracle: 'Oracle Cloud',
  cloudflare: 'Cloudflare',
  ovh: 'OVH',
  linode: 'Linode',
  vultr: 'Vultr',
  home: 'Home lab',
  onprem: 'On-premises',
  other: 'Other',
};

export const DistrictSchema = z.object({
  /** Slug of the name; the label on hosts and resources stays the name itself. */
  id: z.string().min(1),
  name: z.string().min(1),
  provider: DistrictProviderSchema.nullable().default(null),
  /** Provider region or site, e.g. "ap-south-1", "fsn1", "basement". */
  region: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  /** True when nothing in districts.yaml describes it: it exists only through its members. */
  inferred: z.boolean().default(false),
});
export type District = z.infer<typeof DistrictSchema>;

/** "AWS Mumbai" -> "aws-mumbai". Stable as long as the name is. */
export function districtId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'district'
  );
}

/**
 * Declared districts first, then one inferred district per label that only
 * members use. Pure and order-stable, so the server and the demo agree.
 */
export function resolveDistricts(
  declared: readonly District[],
  memberLabels: Iterable<string>,
): District[] {
  const byName = new Map(declared.map((district) => [district.name, district]));
  const result = [...declared];
  for (const label of new Set(memberLabels)) {
    if (byName.has(label)) continue;
    const inferred: District = {
      id: districtId(label),
      name: label,
      provider: null,
      region: null,
      description: null,
      inferred: true,
    };
    byName.set(label, inferred);
    result.push(inferred);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** How a district is doing, from the status of everything in it. */
export interface DistrictHealth {
  total: number;
  online: number;
  degraded: number;
  offline: number;
  unknown: number;
  stale: number;
  /** The worst status among members: offline > degraded > unknown > online. */
  worst: HostStatus;
}

const SEVERITY: Record<HostStatus, number> = { online: 0, unknown: 1, degraded: 2, offline: 3 };

export function districtHealth(
  members: readonly { status: HostStatus; stale: boolean }[],
): DistrictHealth {
  const health: DistrictHealth = {
    total: members.length,
    online: 0,
    degraded: 0,
    offline: 0,
    unknown: 0,
    stale: 0,
    worst: members.length === 0 ? 'unknown' : 'online',
  };
  for (const member of members) {
    health[member.status] += 1;
    if (member.stale) health.stale += 1;
    if (SEVERITY[member.status] > SEVERITY[health.worst]) health.worst = member.status;
  }
  return health;
}
