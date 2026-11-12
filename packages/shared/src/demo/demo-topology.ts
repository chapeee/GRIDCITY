import type { District } from '../district';
import { linkId, mergeLinks, type Link } from '../link';

/**
 * The demo city's districts and topology. Districts here mix everything the
 * way real accounts do: AWS Mumbai holds EC2 servers next to their RDS
 * instances, bucket and load balancer. Links are the ones the real server
 * would build from `dependsOn`, from established connections it saw on the
 * hosts, and from load balancer target groups. Demo data, like the rest.
 */
export const DEMO_DISTRICTS: District[] = [
  {
    id: 'aws-mumbai',
    name: 'AWS Mumbai',
    provider: 'aws',
    region: 'ap-south-1',
    description: 'Lekhix and Ausia production: EC2, RDS, S3 and the ALB in one VPC.',
    inferred: false,
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    provider: 'digitalocean',
    region: 'blr1',
    description: 'Portfolio, SkillGen and side projects on droplets, with Spaces for media.',
    inferred: false,
  },
  {
    id: 'hetzner',
    name: 'Hetzner',
    provider: 'hetzner',
    region: 'fsn1',
    description: 'Open-source tools and small APIs on dedicated boxes.',
    inferred: false,
  },
  {
    id: 'home-lab',
    name: 'Home lab',
    provider: 'home',
    region: 'basement rack',
    description: 'NAS, Pi-hole, media and the lab machine behind the home router.',
    inferred: false,
  },
  {
    id: 'edge',
    name: 'Edge',
    provider: 'cloudflare',
    region: 'anycast',
    description: 'What the public sees: the sites, probed from this machine every few seconds.',
    inferred: false,
  },
  {
    id: 'gcp-frankfurt',
    name: 'GCP Frankfurt',
    provider: 'gcp',
    region: 'europe-west3',
    description: 'The analytics pipeline: GKE nodes, ETL workers, Metabase and Cloud SQL.',
    inferred: false,
  },
  {
    id: 'azure-london',
    name: 'Azure London',
    provider: 'azure',
    region: 'uk-south',
    description: 'Client portals for agency work, behind an Azure load balancer with SQL Server.',
    inferred: false,
  },
  {
    id: 'oracle-hyderabad',
    name: 'Oracle Hyderabad',
    provider: 'oracle',
    region: 'ap-hyderabad-1',
    description: 'Always Free ARM boxes: CI runners, a WireGuard exit and an object store mirror.',
    inferred: false,
  },
];

const DECLARED: [from: string, to: string][] = [
  ['etl-worker', 'analytics-pg'],
  ['etl-worker', 'events-redis'],
  ['metabase', 'analytics-pg'],
  ['gke-node-a', 'events-redis'],
  ['portal-web-1', 'portal-api'],
  ['portal-web-2', 'portal-api'],
  ['portal-api', 'portal-sql'],
  ['portal-jobs', 'portal-sql'],
  ['ci-runner-arm', 'artifact-store'],
  ['minio-mirror', 'backups-bucket'],
  ['ausia-edge', 'ausia-web'],
  ['lekhix-web', 'lekhix-api'],
  ['lekhix-api', 'orders-db'],
  ['lekhix-api', 'rate-limit-cache'],
  ['lekhix-api', 'media-bucket'],
  ['lekhix-scraper', 'events-mongo'],
  ['lekhix-scraper', 'lekhix-api'],
  ['lekhix-backups', 'lekhix-db'],
  ['lekhix-backups', 'backups-bucket'],
  ['skillgen-app', 'session-cache'],
  ['skillgen-app', 'skillgen-redis'],
  ['skillgen-app', 'shop-mysql'],
  ['myselfraj-web', 'media-bucket'],
  ['leadgent-queue', 'skillgen-redis'],
  ['bizmail-api', 'shop-mysql'],
  ['formtest-cron', 'bizmail-api'],
  ['jellyfin', 'home-nas'],
];

/** Established connections the discovery poll would see, with the port. */
const OBSERVED: [from: string, to: string, label: string][] = [
  ['lekhix-api', 'orders-db', ':5432'],
  ['lekhix-api', 'orders-replica', ':5432'],
  ['lekhix-web', 'lekhix-api', ':4000'],
  ['lekhix-api', 'billing-rds', ':5432'],
  ['skillgen-app', 'skillgen-redis', ':6379'],
  ['skillgen-app', 'shop-mysql', ':3306'],
  ['bizmail-api', 'shop-mysql', ':3306'],
  ['lekhix-scraper', 'events-mongo', ':27017'],
  ['leadgent-queue', 'skillgen-redis', ':6379'],
  ['pihole', 'home-nas', ':2049'],
  ['etl-worker', 'analytics-pg', ':5432'],
  ['metabase', 'analytics-pg', ':5432'],
  ['portal-api', 'portal-sql', ':1433'],
  ['portal-jobs', 'portal-sql', ':1433'],
  ['gke-node-b', 'events-redis', ':6379'],
];

const BALANCES: [balancer: string, target: string][] = [
  ['lekhix-alb', 'lekhix-web'],
  ['lekhix-alb', 'ausia-web'],
  ['skillgen-lb', 'skillgen-app'],
  ['skillgen-lb', 'reverse-seo'],
  ['portal-lb', 'portal-web-1'],
  ['portal-lb', 'portal-web-2'],
];

const PROBES: [probe: string, target: string][] = [
  ['probe-lekhix', 'lekhix-alb'],
  ['probe-myselfraj', 'myselfraj-web'],
  ['probe-skillgen', 'skillgen-lb'],
  ['probe-gitsmith', 'gitsmith-docs'],
  ['probe-jellyfin', 'jellyfin'],
  ['probe-nas-smb', 'home-nas'],
  ['probe-portal', 'portal-lb'],
  ['probe-wireguard', 'wireguard-exit'],
];

export function createDemoLinks(now: number): Link[] {
  const link = (from: string, to: string, kind: Link['kind'], label: string | null): Link => ({
    id: linkId(from, to),
    from,
    to,
    kind,
    label,
    lastSeenAt: kind === 'declared' ? null : now,
  });
  return mergeLinks(
    DECLARED.map(([from, to]) => link(from, to, 'declared', null)),
    OBSERVED.map(([from, to, label]) => link(from, to, 'observed', label)),
    BALANCES.map(([from, to]) => link(from, to, 'balances', 'target')),
    PROBES.map(([from, to]) => link(from, to, 'probes', 'https')),
  );
}
