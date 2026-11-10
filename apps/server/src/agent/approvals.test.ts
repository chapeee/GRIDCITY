import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate, type ApprovalRequest } from './approvals';

const ask = (hostId = 'web-1', command = 'df -h'): ApprovalRequest => ({
  hostId,
  hostName: hostId,
  command,
  reason: 'check the disk',
  client: 'Claude Code',
});

describe('ApprovalGate', () => {
  it('waits for the user and runs nothing before', async () => {
    const gate = new ApprovalGate();
    const outcome = gate.request(ask());
    expect(gate.approvals).toHaveLength(1);
    expect(gate.approvals[0]).toMatchObject({ command: 'df -h', client: 'Claude Code' });

    gate.decide(gate.approvals[0]!.id, 'allow');
    await expect(outcome).resolves.toEqual({ allowed: true, by: 'you' });
    expect(gate.approvals).toHaveLength(0);
  });

  it('denies', async () => {
    const gate = new ApprovalGate();
    const outcome = gate.request(ask());
    gate.decide(gate.approvals[0]!.id, 'deny');
    await expect(outcome).resolves.toEqual({ allowed: false, why: 'denied' });
  });

  it('"allow on this server" trusts that host only, until untrusted', async () => {
    const gate = new ApprovalGate();
    const first = gate.request(ask('web-1', 'uptime'));
    const waiting = gate.request(ask('web-1', 'free -m'));
    const other = gate.request(ask('db-1', 'uptime'));
    gate.decide(gate.approvals[0]!.id, 'allow-host');

    await expect(first).resolves.toEqual({ allowed: true, by: 'you' });
    await expect(waiting).resolves.toEqual({ allowed: true, by: 'trusted-host' });
    expect(gate.approvals.map((a) => a.hostId)).toEqual(['db-1']); // still asks for db-1
    await expect(gate.request(ask('web-1'))).resolves.toEqual({
      allowed: true,
      by: 'trusted-host',
    });
    expect(gate.trustedHosts).toEqual(['web-1']);

    gate.untrust('web-1');
    void gate.request(ask('web-1'));
    expect(gate.approvals.map((a) => a.hostId)).toEqual(['db-1', 'web-1']);
    gate.cancelAll();
    await expect(other).resolves.toEqual({ allowed: false, why: 'cancelled' });
  });

  it('denies requests nobody answers', async () => {
    vi.useFakeTimers();
    try {
      const gate = new ApprovalGate({ timeoutMs: 1000 });
      const outcome = gate.request(ask());
      vi.advanceTimersByTime(1001);
      await expect(outcome).resolves.toEqual({ allowed: false, why: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws a request when the AI cancels it', async () => {
    const gate = new ApprovalGate();
    const controller = new AbortController();
    const outcome = gate.request(ask(), controller.signal);
    controller.abort();
    await expect(outcome).resolves.toEqual({ allowed: false, why: 'cancelled' });
    expect(gate.approvals).toHaveLength(0);
  });

  it('ignores answers to requests that are gone', () => {
    const gate = new ApprovalGate();
    expect(() => gate.decide('nope', 'allow')).not.toThrow();
  });
});
