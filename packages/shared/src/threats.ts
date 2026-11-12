import { z } from 'zod';

/**
 * Attack and exposure findings ("threats"): what open-source detectors
 * (CrowdSec, Fail2ban, Wazuh, Falco, GuardDuty) and GRIDCITY's own read-only
 * checks saw on a server or resource. GRIDCITY does not invent detections:
 * every finding says where it came from and what was seen.
 */

export const THREAT_SOURCES = [
  'builtin',
  'crowdsec',
  'fail2ban',
  'wazuh',
  'falco',
  'guardduty',
] as const;
export type ThreatSource = (typeof THREAT_SOURCES)[number];

export const THREAT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ThreatSeverity = (typeof THREAT_SEVERITIES)[number];

export const THREAT_CATEGORIES = [
  'brute-force',
  'port-scan',
  'suspicious-login',
  'new-user',
  'privilege',
  'new-port',
  'exposure',
  'file-integrity',
  'container',
  'cloud',
  'web-attack',
  'other',
  'vulnerable-package',
  // Maintenance: things that will break if nobody acts (see MAINTENANCE_CATEGORIES).
  'certificate',
  'domain',
  'disk-forecast',
  'backup',
  'cost',
] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];

export const ThreatFindingSchema = z.object({
  /** Stable for the same attack: target, source, category and subject. */
  id: z.string(),
  targetId: z.string(),
  source: z.enum(THREAT_SOURCES),
  severity: z.enum(THREAT_SEVERITIES),
  category: z.enum(THREAT_CATEGORIES),
  /** "SSH brute force from 203.0.113.9" */
  title: z.string(),
  /** What was seen, in plain words. */
  detail: z.string(),
  /** What to do about it. */
  advice: z.string(),
  attackerIp: z.string().nullable(),
  /** Attempts or events counted for this finding. */
  count: z.number().int().nonnegative(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  /** Blocked by CrowdSec or Fail2ban; null when nothing says. */
  blocked: z.boolean().nullable(),
  status: z.enum(['open', 'resolved']),
  resolvedAt: z.number().nullable(),
});
export type ThreatFinding = z.infer<typeof ThreatFindingSchema>;

/** What could not be checked on a target and why (no permission, tool missing). */
export const ThreatCoverageSchema = z.object({
  targetId: z.string(),
  checkedAt: z.number(),
  /** e.g. "SSH logins", "CrowdSec". */
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), note: z.string().nullable() })),
});
export type ThreatCoverage = z.infer<typeof ThreatCoverageSchema>;

/**
 * Findings about upkeep rather than attackers: expiring certificates and
 * domains, disks filling up, late backups, cost spikes. Shown in the Upcoming
 * panel; everything else is Security. They alert from medium up (an expiry
 * 30 days out is worth one message), security findings from high up.
 */
export const MAINTENANCE_CATEGORIES: ReadonlySet<ThreatCategory> = new Set([
  'certificate',
  'domain',
  'disk-forecast',
  'backup',
  'cost',
]);

export const isMaintenance = (finding: { category: ThreatCategory }): boolean =>
  MAINTENANCE_CATEGORIES.has(finding.category);

export const SEVERITY_RANK: Record<ThreatSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** The highest severity among open security findings for each target (drives the building ring). */
export function worstOpenSeverity(findings: readonly ThreatFinding[]): Map<string, ThreatSeverity> {
  const worst = new Map<string, ThreatSeverity>();
  for (const finding of findings) {
    if (finding.status !== 'open' || isMaintenance(finding)) continue;
    const current = worst.get(finding.targetId);
    if (!current || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current]) {
      worst.set(finding.targetId, finding.severity);
    }
  }
  return worst;
}

/** Newest and most severe first. */
export function sortFindings(findings: readonly ThreatFinding[]): ThreatFinding[] {
  return [...findings].sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.lastSeen - a.lastSeen,
  );
}

/**
 * Something dated that will need attention: a certificate or domain that
 * expires, a disk that will fill up, the next expected backup. The Upcoming
 * panel lists them all, soonest first, whether or not they are a finding yet.
 */
export interface UpcomingItem {
  targetId: string;
  kind: 'certificate' | 'domain' | 'disk-full' | 'backup';
  /** "orders.example.com", "/var", "nightly dump" */
  label: string;
  /** When it happens (expiry, disk full, backup due); null when unknown. */
  at: number | null;
  status: 'ok' | 'soon' | 'urgent' | 'overdue' | 'unknown';
  detail: string;
}

export interface ThreatsView {
  findings: ThreatFinding[];
  coverage: ThreatCoverage[];
  upcoming: UpcomingItem[];
  /** Demo data never has real findings. */
  demo: boolean;
}
