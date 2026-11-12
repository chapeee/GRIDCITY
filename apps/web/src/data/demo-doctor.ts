import type { Diagnosis, DoctorReport, Fix, LadderStep } from '@app/shared';

/**
 * Simulated Doctor reports for the demo city (DEMO DATA). With real servers
 * the server runs the ladder against the real target and proves each fix
 * first; here a believable report is built from the building's demo state,
 * so the online demo can show what the Doctor does without a server.
 */
export interface DemoDoctorTarget {
  id: string;
  name: string;
  /** 'server' for hosts, else the resource kind (redis, postgres, s3, http…). */
  kind: string;
  /** host:port, address or URL. */
  address: string;
  status: string;
  stale: boolean;
  reason: string | null;
}

const step = (
  name: LadderStep['step'],
  status: LadderStep['status'],
  detail: string,
  ms: number | null,
): LadderStep => ({ step: name, status, detail, ms });

const fix = (partial: Partial<Fix> & Pick<Fix, 'id' | 'label'>): Fix => ({
  kind: 'manual',
  patch: null,
  risk: 'safe',
  steps: [],
  command: null,
  verified: 'untested',
  verifyNote: null,
  ...partial,
});

const PORTS: Record<string, number> = {
  redis: 6379,
  postgres: 5432,
  mysql: 3306,
  mongodb: 27017,
  mssql: 1433,
  server: 22,
};

function hostPart(address: string): string {
  try {
    if (address.includes('://')) return new URL(address).hostname;
  } catch {
    // fall through
  }
  return address.replace(/:\d+$/, '');
}

function healthyLadder(target: DemoDoctorTarget): LadderStep[] {
  const host = hostPart(target.address);
  const ladder = [
    step('dns', 'ok', `${host} resolves`, 3),
    step('tcp', 'ok', `port ${PORTS[target.kind] ?? 443} accepts connections`, 21),
  ];
  if (['http', 's3', 'rds', 'loadbalancer', 'mssql'].includes(target.kind)) {
    ladder.push(step('tls', 'ok', 'certificate valid, chain trusted', 48));
  }
  ladder.push(
    step(
      'login',
      'ok',
      target.kind === 'server' ? 'key accepted for ops' : 'credentials accepted',
      35,
    ),
    step('access', 'ok', 'read-only checks pass', 12),
  );
  return ladder;
}

function diagnosesFor(target: DemoDoctorTarget): { ladder: LadderStep[]; diagnoses: Diagnosis[] } {
  const reason = target.reason ?? '';
  const port = PORTS[target.kind] ?? 443;
  const host = hostPart(target.address);

  if (target.stale) {
    return {
      ladder: healthyLadder(target),
      diagnoses: [
        {
          id: 'poller-stuck',
          title: 'The target answers, but its updates stopped arriving',
          explanation:
            'Every check passes right now, so the target is fine: the polling connection is stuck. The Doctor reconnects it; the building lights up again on the next poll.',
          confidence: 'likely',
          evidence: ['all ladder steps pass', `last update ${reason || 'over a minute ago'}`],
          fixes: [
            fix({
              id: 'reconnect',
              label: 'Reconnect the poller',
              kind: 'patch',
              patch: { reconnect: true },
              verified: 'works',
              verifyNote: 'a fresh connection returned metrics in 0.4 s',
            }),
          ],
        },
      ],
    };
  }

  if (target.status === 'offline' && /ECONNREFUSED|refused/i.test(reason)) {
    const next = port + 1;
    return {
      ladder: [
        step('dns', 'ok', `${host} resolves`, 2),
        step('tcp', 'failed', `nothing accepts connections on port ${port}`, 4),
        step('tls', 'skipped', 'no connection', null),
        step('login', 'skipped', 'no connection', null),
        step('access', 'skipped', 'no connection', null),
      ],
      diagnoses: [
        {
          id: 'port-closed',
          title: `Nothing listens on port ${port}`,
          explanation: `The machine answers, but the service is stopped or moved to another port. A scan of nearby ports found it listening on ${next}.`,
          confidence: 'certain',
          evidence: [`connect ECONNREFUSED ${host}:${port}`, `${host}:${next} accepts connections`],
          fixes: [
            fix({
              id: 'use-found-port',
              label: `Use port ${next}, where it answers`,
              kind: 'patch',
              patch: { port: next },
              verified: 'works',
              verifyNote: `connected and authenticated on ${host}:${next}`,
            }),
            fix({
              id: 'restart-service',
              label: 'Start the service on its usual port',
              steps: ['Check why it stopped in its log', 'Start it and enable it at boot'],
              command:
                target.kind === 'redis'
                  ? 'sudo systemctl enable --now redis-server && redis-cli ping'
                  : `sudo systemctl enable --now ${target.kind}`,
            }),
          ],
        },
      ],
    };
  }

  if (target.status === 'offline') {
    return {
      ladder: [
        step('dns', 'ok', `${host} resolves`, 3),
        step('tcp', 'failed', `no answer on port ${port} after 5 s`, 5000),
        step('tls', 'skipped', 'no connection', null),
        step('login', 'skipped', 'no connection', null),
        step('access', 'skipped', 'no connection', null),
      ],
      diagnoses: [
        {
          id: 'unreachable',
          title: 'The machine does not answer at all',
          explanation:
            'Packets are dropped, not refused: the machine is down, or a firewall or security group blocks this port from your address.',
          confidence: 'likely',
          evidence: [`timeout connecting to ${host}:${port}`, 'no ICMP reply', reason].filter(
            Boolean,
          ),
          fixes: [
            fix({
              id: 'check-firewall',
              label: 'Allow your address in the firewall or security group',
              steps: [
                `Open the provider console for ${target.name}`,
                `Allow TCP ${port} from your public IP`,
              ],
              command: `sudo ufw allow from <your-ip> to any port ${port} proto tcp`,
            }),
            fix({
              id: 'power-on',
              label: 'Start the machine from the provider console',
              steps: ['Check its state in the console', 'Start or reboot it'],
            }),
          ],
        },
      ],
    };
  }

  if (target.status === 'degraded' && /replica|lag|behind/i.test(reason)) {
    return {
      ladder: healthyLadder(target),
      diagnoses: [
        {
          id: 'replica-lag',
          title: 'The replica is falling behind the primary',
          explanation:
            'It is connected and answering, but replays changes slower than the primary writes them; reads from it return old data.',
          confidence: 'likely',
          evidence: [reason, 'WAL receiver connected', 'replay rate below write rate'],
          fixes: [
            fix({
              id: 'check-lag',
              label: 'See what holds the replay back',
              command:
                'psql -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag, pid, state, query FROM pg_stat_activity WHERE state <> \'idle\';"',
              steps: [
                'Long queries on the replica pause replay',
                'Cancel them or raise max_standby_streaming_delay',
              ],
            }),
          ],
        },
      ],
    };
  }

  if (target.status === 'degraded') {
    const memory = /memory/i.test(reason);
    const disk = /disk/i.test(reason);
    return {
      ladder: healthyLadder(target),
      diagnoses: [
        {
          id: memory ? 'memory-pressure' : disk ? 'disk-filling' : 'cpu-saturated',
          title: memory
            ? 'Memory keeps growing: likely a leak'
            : disk
              ? 'A disk is filling up'
              : 'The CPU is saturated',
          explanation: memory
            ? 'Memory climbs steadily without dropping back after load, the pattern of a leak. Restarting the service frees it; the leak itself needs a fix in the app.'
            : disk
              ? 'At the current rate the disk fills within days. Old logs and package caches are the usual cause.'
              : 'One process uses most of the CPU, so everything else on the machine slows down.',
          confidence: 'likely',
          evidence: [reason || target.status],
          fixes: [
            fix({
              id: 'inspect',
              label: memory
                ? 'Find the process and restart its service'
                : disk
                  ? 'Find what fills the disk'
                  : 'Find the busy process',
              command: memory
                ? 'ps aux --sort=-%mem | head -5'
                : disk
                  ? 'sudo du -xh / --max-depth=2 | sort -h | tail -15'
                  : 'top -b -n1 -o %CPU | head -15',
              steps: memory
                ? ['Restart the service that owns it', 'Open an issue with the heap growth']
                : disk
                  ? ['sudo journalctl --vacuum-time=7d', 'sudo apt-get clean']
                  : ['Check whether it is a scheduled job', 'Limit or move it'],
            }),
          ],
        },
      ],
    };
  }

  return { ladder: healthyLadder(target), diagnoses: [] };
}

export function demoDiagnose(target: DemoDoctorTarget, now = Date.now()): DoctorReport {
  const { ladder, diagnoses } = diagnosesFor(target);
  return {
    targetId: target.id,
    targetName: target.name,
    ok: diagnoses.length === 0,
    error: null,
    ladder,
    diagnoses,
    at: now,
  };
}
