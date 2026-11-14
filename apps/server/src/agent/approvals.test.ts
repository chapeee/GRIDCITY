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
    await expect(outcome).resolves.toEqual({ allowed: true, by: 'you', note: null, answer: null });
    expect(gate.approvals).toHaveLength(0);
  });

  it('denies', async () => {
    const gate = new ApprovalGate();
    const outcome = gate.request(ask());
    gate.decide(gate.approvals[0]!.id, 'deny');
    await expect(outcome).resolves.toEqual({ allowed: false, why: 'denied', note: null });
  });

  it('"allow on this server" trusts that host only, until untrusted', async () => {
    const gate = new ApprovalGate();
    const first = gate.request(ask('web-1', 'uptime'));
    const waiting = gate.request(ask('web-1', 'free -m'));
    const other = gate.request(ask('db-1', 'uptime'));
    gate.decide(gate.approvals[0]!.id, 'allow-host');

    await expect(first).resolves.toEqual({ allowed: true, by: 'you', note: null, answer: null });
    await expect(waiting).resolves.toEqual({
      allowed: true,
      by: 'trusted-host',
      note: null,
      answer: null,
    });
    expect(gate.approvals.map((a) => a.hostId)).toEqual(['db-1']); // still asks for db-1
    await expect(gate.request(ask('web-1'))).resolves.toEqual({
      allowed: true,
      by: 'trusted-host',
      note: null,
      answer: null,
    });
    expect(gate.trustedHosts).toEqual(['web-1']);

    gate.untrust('web-1');
    void gate.request(ask('web-1'));
    expect(gate.approvals.map((a) => a.hostId)).toEqual(['db-1', 'web-1']);
    gate.cancelAll();
    await expect(other).resolves.toEqual({ allowed: false, why: 'cancelled', note: null });
  });

  it('denies requests nobody answers', async () => {
    vi.useFakeTimers();
    try {
      const gate = new ApprovalGate({ timeoutMs: 1000 });
      const outcome = gate.request(ask());
      vi.advanceTimersByTime(1001);
      await expect(outcome).resolves.toEqual({ allowed: false, why: 'timeout', note: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws a request when the AI cancels it', async () => {
    const gate = new ApprovalGate();
    const controller = new AbortController();
    const outcome = gate.request(ask(), controller.signal);
    controller.abort();
    await expect(outcome).resolves.toEqual({ allowed: false, why: 'cancelled', note: null });
    expect(gate.approvals).toHaveLength(0);
  });

  it('ignores answers to requests that are gone', () => {
    const gate = new ApprovalGate();
    expect(() => gate.decide('nope', 'allow')).not.toThrow();
  });
});

describe('ApprovalGate on a trusted server', () => {
  const sudoInput = { prompt: 'sudo password for ops', secret: true, optional: true };
  const sudo = (command = 'sudo apt-get update'): ApprovalRequest => ({
    ...ask('web-1', command),
    input: sudoInput,
    sudoPassword: true,
  });
  const trust = async (
    gate: ApprovalGate,
    request: ApprovalRequest,
    answer?: string,
    remember = true,
  ) => {
    const outcome = gate.request(request);
    gate.decide(gate.approvals[0]!.id, 'allow-host', { answer, remember });
    return outcome;
  };

  it('still asks for destructive commands, and says why', async () => {
    const gate = new ApprovalGate();
    await trust(gate, ask());
    await expect(gate.request(ask('web-1', 'uptime'))).resolves.toMatchObject({
      by: 'trusted-host',
    });

    const outcome = gate.request({ ...ask('web-1', 'rm -rf /srv/app'), risk: 'deletes files' });
    expect(gate.approvals).toHaveLength(1);
    expect(gate.approvals[0]).toMatchObject({ risk: 'deletes files' });
    gate.decide(gate.approvals[0]!.id, 'allow');
    await expect(outcome).resolves.toMatchObject({ allowed: true, by: 'you' });
  });

  it('keeps the sudo password only for this command when not saved', async () => {
    const gate = new ApprovalGate();
    await expect(trust(gate, sudo(), 'hunter2', false)).resolves.toMatchObject({
      answer: 'hunter2',
    });
    void gate.request(sudo('sudo systemctl restart nginx'));
    expect(gate.approvals).toHaveLength(1);
    expect(gate.approvals[0]).toMatchObject({ sudo: true, sudoSavedUntil: null });
  });

  it('fills cards that still ask with the saved password, for one hour', async () => {
    let now = 1_000;
    const gate = new ApprovalGate({ now: () => now });
    await trust(gate, sudo(), 'hunter2');

    // A destructive command still asks, but nothing has to be typed.
    const outcome = gate.request({ ...sudo('sudo rm -rf /srv/old'), risk: 'deletes files' });
    expect(gate.approvals[0]).toMatchObject({ sudo: true, sudoSavedUntil: 1_000 + 3_600_000 });
    gate.decide(gate.approvals[0]!.id, 'allow');
    await expect(outcome).resolves.toMatchObject({ by: 'you', answer: 'hunter2' });

    // A different password typed on the card wins.
    const typed = gate.request({ ...sudo('sudo rm -rf /srv/old'), risk: 'deletes files' });
    gate.decide(gate.approvals[0]!.id, 'allow', { answer: 'other' });
    await expect(typed).resolves.toMatchObject({ answer: 'other' });

    // After the hour it is gone.
    now += 3_600_000;
    void gate.request(sudo());
    expect(gate.approvals).toHaveLength(1);
    expect(gate.approvals[0]).toMatchObject({ sudoSavedUntil: null });
  });

  it('remembers the sudo password saved with allow all, for that server only', async () => {
    const gate = new ApprovalGate();
    await expect(trust(gate, sudo(), 'hunter2')).resolves.toMatchObject({ answer: 'hunter2' });

    await expect(gate.request(sudo('sudo systemctl restart nginx'))).resolves.toEqual({
      allowed: true,
      by: 'trusted-host',
      note: null,
      answer: 'hunter2',
    });
    expect(gate.approvals).toHaveLength(0);

    // Another server still asks.
    void gate.request({ ...sudo(), hostId: 'db-1', hostName: 'db-1' });
    expect(gate.approvals).toHaveLength(1);
  });

  it('asks again after the password is rejected or the server is untrusted', async () => {
    const gate = new ApprovalGate();
    await trust(gate, sudo(), 'wrong');
    gate.forgetSudoPassword('web-1');
    void gate.request(sudo());
    expect(gate.approvals).toHaveLength(1);
    gate.decide(gate.approvals[0]!.id, 'allow-host', { answer: 'right', remember: true });
    await expect(gate.request(sudo())).resolves.toMatchObject({ answer: 'right' });

    gate.untrust('web-1');
    void gate.request(sudo());
    expect(gate.approvals).toHaveLength(1);
  });

  it('keeps asking for input the AI declared, like a token', async () => {
    const gate = new ApprovalGate();
    await trust(gate, ask());
    void gate.request({
      ...ask(),
      input: { prompt: 'registry token', secret: true, optional: false },
    });
    expect(gate.approvals).toHaveLength(1);
  });
});
