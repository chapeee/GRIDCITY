import { z } from 'zod';

/** How this copy was installed: decides what "how to update" says. */
export const InstallKindSchema = z.enum(['desktop', 'npm', 'docker']);
export type InstallKind = z.infer<typeof InstallKindSchema>;

/**
 * Whether a newer GRIDCITY exists. The server asks GitHub's public releases
 * page once a day (nothing about the user or their servers is sent) unless
 * the check is turned off in Settings or with GRIDCITY_UPDATE_CHECK=off.
 */
export const UpdateInfoSchema = z.object({
  /** The version running now, e.g. "1.0.0". */
  current: z.string(),
  /** The newest published release, or null before the first answer. */
  latest: z.string().nullable(),
  /** True when `latest` is newer than `current`. */
  available: z.boolean(),
  /** The release page with notes and downloads. */
  releaseUrl: z.string().nullable(),
  /** When GitHub last answered (epoch ms), or null. */
  checkedAt: z.number().int().nullable(),
  /** Off in Settings or by the environment. */
  enabled: z.boolean(),
  /** Turned off by GRIDCITY_UPDATE_CHECK=off: Settings cannot turn it on. */
  lockedOff: z.boolean(),
  install: InstallKindSchema,
  /** Why the last check failed (offline, rate limit), or null. */
  error: z.string().nullable(),
});
export type UpdateInfo = z.infer<typeof UpdateInfoSchema>;

/** "v1.2.3" or "1.2.3" -> [1, 2, 3]; anything else (betas included) -> null. */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `candidate` is a later release than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}
