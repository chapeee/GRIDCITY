import { z } from 'zod';

/**
 * How the server authenticates to a host.
 *
 * Secrets are never part of this model: `agent` delegates to the system
 * ssh-agent, and `keyFile` stores only a *path* that is read at connect time.
 * Private keys, passphrases and passwords never reach our storage.
 */
export const HostAuthSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('agent') }),
  z.object({
    method: z.literal('keyFile'),
    /** Absolute or `~`-relative path to a private key on the local machine. */
    path: z.string().min(1, 'keyFile auth needs a path to the private key'),
  }),
]);
export type HostAuth = z.infer<typeof HostAuthSchema>;

/**
 * A server the user wants to see in the world, as configured in hosts.yaml.
 * This is static configuration; live data lives in {@link HostState}.
 */
export const HostSchema = z.object({
  /** Stable identifier. Used for layout persistence, so it must not change on rename. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id may only contain a-z, 0-9, "-" and "_"'),
  /** Human-readable label shown on the tower and in the command palette. */
  name: z.string().min(1),
  /** Hostname or IP address the SSH connection dials. */
  address: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  /** Remote login user. */
  user: z.string().min(1),
  /** Grouping label (provider, site, client). Each distinct value becomes a district. */
  district: z.string().min(1).default('default'),
  tags: z.array(z.string().min(1)).default([]),
  auth: HostAuthSchema.default({ method: 'agent' }),
});
export type Host = z.infer<typeof HostSchema>;
/** Host as written by the user, before defaults are applied. */
export type HostInput = z.input<typeof HostSchema>;
