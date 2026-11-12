import { describe, expect, it } from 'vitest';
import { buildIncidentTimeline } from './incident';

describe('incident timeline', () => {
  it('puts status changes, findings, commands and alerts in order, for one building or all', () => {
    const input = {
      since: 0,
      until: 10_000,
      targetId: null as string | null,
      statuses: [
        { targetId: 'db', at: 3000, status: 'offline' as const, reason: 'ECONNREFUSED' },
        { targetId: 'db', at: 9000, status: 'online' as const, reason: null },
      ],
      findings: [
        {
          id: 'web:brute-force:1.2.3.4',
          targetId: 'web',
          source: 'builtin' as const,
          severity: 'high' as const,
          category: 'brute-force' as const,
          title: 'SSH brute force from 1.2.3.4',
          detail: '',
          advice: '',
          attackerIp: '1.2.3.4',
          count: 50,
          firstSeen: 1000,
          lastSeen: 2000,
          blocked: null,
          status: 'resolved' as const,
          resolvedAt: 8000,
        },
      ],
      audit: [
        {
          id: 1,
          at: 2500,
          kind: 'agent_command_run' as const,
          hostId: 'db',
          detail: 'systemctl stop postgresql',
        },
        {
          id: 2,
          at: 3100,
          kind: 'alert_sent' as const,
          hostId: 'db',
          detail: 'online → offline · Ops email',
        },
        {
          id: 3,
          at: 1000,
          kind: 'threat_opened' as const,
          hostId: 'web',
          detail: 'duplicate of the finding',
        },
      ],
    };
    const all = buildIncidentTimeline(input);
    expect(all.map((e) => `${e.at}:${e.kind}:${e.title}`)).toEqual([
      '1000:finding:SSH brute force from 1.2.3.4',
      '2500:command:agent command run',
      '3000:status:offline',
      '3100:alert:alert sent',
      '8000:finding-ended:ended: SSH brute force from 1.2.3.4',
      '9000:status:back online',
    ]);
    expect(
      buildIncidentTimeline({ ...input, targetId: 'db' }).every((e) => e.targetId === 'db'),
    ).toBe(true);
  });
});
