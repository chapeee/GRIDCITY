import { z } from 'zod';

/**
 * What runs on a server, discovered over the existing SSH connection with
 * read-only commands (`ss`, `systemctl`, `docker ps`, a few files under
 * /var). Collected on a slower rhythm than metrics (every 30 s by default),
 * because it rarely changes and `docker ps` is not free.
 *
 * Truth rules: `null` means the server could not tell (no docker, no
 * systemd, no permission), never "none". An empty list means "looked, found
 * nothing".
 */
export const ListeningPortSchema = z.object({
  port: z.number().int().min(0).max(65535),
  protocol: z.enum(['tcp', 'udp']),
  /** 0.0.0.0, ::, 127.0.0.1 or a specific address. */
  address: z.string(),
  /** Process name when `ss -p` could see it (root or own processes); null otherwise. */
  process: z.string().nullable(),
});
export type ListeningPort = z.infer<typeof ListeningPortSchema>;

export const ContainerSchema = z.object({
  name: z.string(),
  image: z.string(),
  /** running, exited, restarting, paused, created, dead. */
  state: z.string(),
  /** Docker's human status, e.g. "Up 3 days (healthy)". */
  status: z.string(),
});
export type Container = z.infer<typeof ContainerSchema>;

export const HostServicesSchema = z.object({
  /** When this inventory was collected (epoch ms). */
  collectedAt: z.number().int(),
  listening: z.array(ListeningPortSchema),
  /** Null when docker is not installed or not reachable by this user. */
  containers: z.array(ContainerSchema).nullable(),
  /** systemd units in the failed state; null without systemd. */
  failedUnits: z.array(z.string()).nullable(),
  /** Debian/Ubuntu: /var/run/reboot-required exists. Null when not determinable. */
  rebootRequired: z.boolean().nullable(),
  /** Pending package updates (Ubuntu update-notifier, dnf/yum check-update); null when unknown. */
  pendingUpdates: z.number().int().nonnegative().nullable(),
  /** Security updates among them, when the distribution says. */
  pendingSecurityUpdates: z.number().int().nonnegative().nullable(),
});
export type HostServices = z.infer<typeof HostServicesSchema>;

/** Reasons the inventory adds to a host's status line (not a status change on its own). */
export function serviceWarnings(services: HostServices | null | undefined): string[] {
  if (!services) return [];
  const warnings: string[] = [];
  if (services.failedUnits && services.failedUnits.length > 0) {
    warnings.push(
      `${services.failedUnits.length} failed unit${services.failedUnits.length === 1 ? '' : 's'}: ${services.failedUnits.slice(0, 3).join(', ')}`,
    );
  }
  const unhealthy = (services.containers ?? []).filter(
    (container) => container.state !== 'running' || /unhealthy/i.test(container.status),
  );
  if (unhealthy.length > 0) {
    warnings.push(
      `${unhealthy.length} container${unhealthy.length === 1 ? '' : 's'} not running: ${unhealthy
        .slice(0, 3)
        .map((c) => c.name)
        .join(', ')}`,
    );
  }
  if (services.rebootRequired) warnings.push('reboot required');
  if (services.pendingSecurityUpdates) {
    warnings.push(`${services.pendingSecurityUpdates} security updates pending`);
  }
  return warnings;
}

/** Well-known ports, for captions ("5432 postgres"). Kept short on purpose. */
export const WELL_KNOWN_PORTS: Record<number, string> = {
  22: 'ssh',
  25: 'smtp',
  53: 'dns',
  80: 'http',
  443: 'https',
  465: 'smtps',
  587: 'submission',
  993: 'imaps',
  1433: 'mssql',
  2375: 'docker',
  2376: 'docker-tls',
  3000: 'app',
  3306: 'mysql',
  5000: 'app',
  5432: 'postgres',
  5672: 'amqp',
  6379: 'redis',
  6443: 'kubernetes',
  8000: 'app',
  8080: 'http-alt',
  8443: 'https-alt',
  9000: 'minio',
  9090: 'prometheus',
  9100: 'node-exporter',
  11211: 'memcached',
  27017: 'mongodb',
};

export function portName(port: number, process: string | null): string {
  return process ?? WELL_KNOWN_PORTS[port] ?? '';
}
