import { z } from 'zod';

/**
 * The Doctor's wire model: why something cannot connect, in plain words,
 * with fixes that were tested against the real target before they are
 * offered. Used by the connect dialog, both HUDs, the Doctor panel and the
 * AI tools, so humans and agents see the same diagnosis.
 *
 * A diagnosis is a hypothesis about the root cause. Its `confidence` says how
 * sure the rule is from the evidence alone; a fix whose `verified` is
 * `works` was proven by a real connection with the change applied.
 */

/** The rungs a connection climbs. The first rung that fails is where the problem is. */
export const LadderStepNameSchema = z.enum(['dns', 'tcp', 'tls', 'login', 'access']);
export type LadderStepName = z.infer<typeof LadderStepNameSchema>;

export const LadderStepSchema = z.object({
  step: LadderStepNameSchema,
  status: z.enum(['ok', 'failed', 'warning', 'skipped']),
  /** One line: "203.0.113.5 (public)", "port 3306 open in 41 ms", "TLS 1.3, issued by …". */
  detail: z.string(),
  ms: z.number().nonnegative().nullable(),
});
export type LadderStep = z.infer<typeof LadderStepSchema>;

export const FixSchema = z.object({
  id: z.string(),
  label: z.string(),
  /**
   * patch: a change to the entry's settings the app can apply for you.
   * manual: steps only a person can do (grant a privilege, open a firewall).
   */
  kind: z.enum(['patch', 'manual']),
  /** Settings to merge into the entry (patch fixes). Only allow-listed keys. */
  patch: z.record(z.string(), z.unknown()).nullable(),
  /** `lower-security`: works, but weakens a protection (skips certificate checks). Needs a deliberate click. */
  risk: z.enum(['safe', 'lower-security']),
  /** What to do, in order (manual fixes, or what the patch means). */
  steps: z.array(z.string()),
  /** A command or statement to copy, when one exists. */
  command: z.string().nullable(),
  /** works: a real connection with this patch succeeded. fails: it was tried and did not help. */
  verified: z.enum(['works', 'fails', 'untested']),
  /** What the verification attempt said (the new error, or what it read). */
  verifyNote: z.string().nullable(),
});
export type Fix = z.infer<typeof FixSchema>;

export const DiagnosisSchema = z.object({
  /** Stable rule id, e.g. "mysql.tls-required". */
  id: z.string(),
  title: z.string(),
  /** Why it happens, for someone who has never seen this error. */
  explanation: z.string(),
  confidence: z.enum(['certain', 'likely', 'possible']),
  /** Facts that support it: the error text, a ladder rung, a provider detected. */
  evidence: z.array(z.string()),
  fixes: z.array(FixSchema),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const DoctorReportSchema = z.object({
  targetId: z.string().nullable(),
  targetName: z.string(),
  /** True when the target answered normally (nothing to fix). */
  ok: z.boolean(),
  /** The raw error, scrubbed of secrets. */
  error: z.string().nullable(),
  ladder: z.array(LadderStepSchema),
  diagnoses: z.array(DiagnosisSchema),
  /** When the report was made (epoch ms). */
  at: z.number().int(),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

/** A short hint attached to live state: the top diagnosis, without network tests. */
export const DoctorHintSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** First fix label, e.g. "Turn on TLS". */
  action: z.string().nullable(),
});
export type DoctorHint = z.infer<typeof DoctorHintSchema>;

/** Orders diagnoses: certain before likely before possible; verified fixes first inside. */
export function rankDiagnoses(diagnoses: readonly Diagnosis[]): Diagnosis[] {
  const confidence = { certain: 0, likely: 1, possible: 2 } as const;
  const verified = { works: 0, untested: 1, fails: 2 } as const;
  return diagnoses
    .map((d) => ({
      ...d,
      fixes: [...d.fixes].sort((a, b) => verified[a.verified] - verified[b.verified]),
    }))
    .sort((a, b) => {
      const aWorks = a.fixes.some((f) => f.verified === 'works') ? 0 : 1;
      const bWorks = b.fixes.some((f) => f.verified === 'works') ? 0 : 1;
      return aWorks - bWorks || confidence[a.confidence] - confidence[b.confidence];
    });
}

export function hintOf(diagnoses: readonly Diagnosis[]): DoctorHint | null {
  const top = rankDiagnoses(diagnoses)[0];
  if (!top) return null;
  return { id: top.id, title: top.title, action: top.fixes[0]?.label ?? null };
}

/**
 * Managed services recognised from their hostname, with what they require.
 * Prevention: the connect form applies these before the first attempt, so
 * "TLS required" and "wrong port" never happen for the common providers.
 */
export interface ProviderProfile {
  id: string;
  name: string;
  /** TLS is mandatory on this service. */
  tlsRequired: boolean;
  /** The port the service uses when it is not the engine default. */
  port?: number;
  /** The service signs certificates with its own CA: paste its CA certificate to verify. */
  privateCa?: { where: string };
  /** One line the form shows. */
  note: string;
}

interface ProviderRule {
  pattern: RegExp;
  kinds: readonly string[];
  profile: (kind: string) => ProviderProfile;
}

const PROVIDERS: ProviderRule[] = [
  {
    pattern: /\.db\.ondigitalocean\.com$/i,
    kinds: ['postgres', 'mysql', 'redis', 'mongodb'],
    profile: (kind) => ({
      id: 'digitalocean',
      name: 'DigitalOcean Managed Database',
      tlsRequired: true,
      port: kind === 'redis' ? 25061 : kind === 'mongodb' ? 27017 : 25060,
      privateCa: {
        where: 'Databases → your cluster → Connection details → Download CA certificate',
      },
      note: 'TLS is required, and the cluster uses its own CA: paste the CA certificate to verify it.',
    }),
  },
  {
    pattern: /\.rds\.amazonaws\.com$/i,
    kinds: ['postgres', 'mysql', 'mssql'],
    profile: () => ({
      id: 'aws-rds',
      name: 'Amazon RDS',
      tlsRequired: false,
      privateCa: { where: 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem' },
      note: 'TLS is recommended (often enforced by the parameter group); RDS uses the Amazon RDS CA bundle.',
    }),
  },
  {
    pattern: /\.(mysql|postgres)\.database\.azure\.com$/i,
    kinds: ['postgres', 'mysql'],
    profile: () => ({
      id: 'azure',
      name: 'Azure Database',
      tlsRequired: true,
      note: 'Azure requires TLS by default (require_secure_transport / require_secure_transport=ON).',
    }),
  },
  {
    pattern: /\.database\.windows\.net$/i,
    kinds: ['mssql'],
    profile: () => ({
      id: 'azure-sql',
      name: 'Azure SQL',
      tlsRequired: true,
      note: 'Azure SQL requires encryption; keep "Encrypt" on and "Trust server certificate" off.',
    }),
  },
  {
    pattern: /(\.supabase\.co|\.pooler\.supabase\.com)$/i,
    kinds: ['postgres'],
    profile: () => ({
      id: 'supabase',
      name: 'Supabase',
      tlsRequired: true,
      note: 'Supabase requires TLS.',
    }),
  },
  {
    pattern: /\.neon\.tech$/i,
    kinds: ['postgres'],
    profile: () => ({ id: 'neon', name: 'Neon', tlsRequired: true, note: 'Neon requires TLS.' }),
  },
  {
    pattern: /\.psdb\.cloud$/i,
    kinds: ['mysql'],
    profile: () => ({
      id: 'planetscale',
      name: 'PlanetScale',
      tlsRequired: true,
      note: 'PlanetScale requires TLS with a publicly trusted certificate.',
    }),
  },
  {
    pattern: /\.upstash\.io$/i,
    kinds: ['redis'],
    profile: () => ({
      id: 'upstash',
      name: 'Upstash',
      tlsRequired: true,
      note: 'Upstash Redis requires TLS.',
    }),
  },
  {
    pattern: /\.cache\.amazonaws\.com$/i,
    kinds: ['redis'],
    profile: () => ({
      id: 'elasticache',
      name: 'Amazon ElastiCache',
      tlsRequired: false,
      note: 'Clusters with in-transit encryption need TLS; it is reachable only from inside the VPC.',
    }),
  },
  {
    pattern: /\.(redislabs|redis-cloud|cloud\.redislabs)\.com$|\.redns\.redis-cloud\.com$/i,
    kinds: ['redis'],
    profile: () => ({
      id: 'redis-cloud',
      name: 'Redis Cloud',
      tlsRequired: false,
      note: 'TLS is optional per database on Redis Cloud.',
    }),
  },
  {
    pattern: /\.mongodb\.net$/i,
    kinds: ['mongodb'],
    profile: () => ({
      id: 'atlas',
      name: 'MongoDB Atlas',
      tlsRequired: true,
      note: 'Atlas requires TLS (mongodb+srv:// turns it on) and an IP access list entry for this machine.',
    }),
  },
  {
    pattern: /\.aivencloud\.com$/i,
    kinds: ['postgres', 'mysql', 'redis'],
    profile: () => ({
      id: 'aiven',
      name: 'Aiven',
      tlsRequired: true,
      privateCa: { where: 'Aiven console → service → Overview → CA certificate' },
      note: 'Aiven requires TLS and signs with a project CA: paste it to verify.',
    }),
  },
];

/** The managed service a host belongs to, if we know it. */
export function detectProvider(kind: string, host: string): ProviderProfile | null {
  const name =
    host
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\/([^@/]*@)?/, '')
      .split(/[:/?]/)[0] ?? '';
  for (const rule of PROVIDERS) {
    if (rule.kinds.includes(kind) && rule.pattern.test(name)) return rule.profile(kind);
  }
  return null;
}
