import { describe, expect, it } from 'vitest';
import { HostSchema } from './host';
import { createUnknownHostState, HostStateSchema } from './host-state';
import { ServerMessageSchema } from './protocol';
import { DEFAULT_STATUS_THRESHOLDS } from './thresholds';

describe('HostSchema', () => {
  it('applies defaults for port, district, tags and auth', () => {
    const host = HostSchema.parse({ id: 'web-1', name: 'web 1', address: '10.0.0.5', user: 'ops' });
    expect(host).toMatchObject({
      port: 22,
      district: 'default',
      tags: [],
      auth: { method: 'agent' },
    });
  });

  it('accepts key file auth with a path', () => {
    const host = HostSchema.parse({
      id: 'db',
      name: 'db',
      address: 'db.internal',
      user: 'root',
      auth: { method: 'keyFile', path: '~/.ssh/id_ed25519' },
    });
    expect(host.auth).toEqual({ method: 'keyFile', path: '~/.ssh/id_ed25519' });
  });

  it('rejects ids that are unsafe for storage keys', () => {
    const result = HostSchema.safeParse({ id: 'Web 1', name: 'x', address: 'x', user: 'x' });
    expect(result.success).toBe(false);
  });

  it('explains that password auth is unsupported because passwords are never stored', () => {
    const result = HostSchema.safeParse({
      id: 'a',
      name: 'a',
      address: 'a',
      user: 'a',
      auth: { method: 'sshPassword', password: 'x' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/passwords are never stored.*agent.*keyFile/);
  });

  it('explains a numeric id', () => {
    const result = HostSchema.safeParse({ id: 1, name: 'a', address: 'a', user: 'a' });
    expect(result.error?.issues[0]?.message).toMatch(/id must be text such as "web-01"/);
  });

  it('rejects out-of-range ports', () => {
    const result = HostSchema.safeParse({ id: 'a', name: 'a', address: 'a', user: 'a', port: 0 });
    expect(result.success).toBe(false);
  });
});

describe('HostStateSchema', () => {
  it('accepts the all-unknown initial state', () => {
    const state = createUnknownHostState('web-1');
    expect(HostStateSchema.parse(state)).toEqual(state);
    expect(state.status).toBe('unknown');
    expect(state.cpuPercent).toBeNull();
  });
});

describe('ServerMessageSchema', () => {
  it('parses a hello message', () => {
    const message = ServerMessageSchema.parse({
      type: 'hello',
      protocolVersion: 1,
      dataMode: 'demo',
      projectName: 'example',
      thresholds: DEFAULT_STATUS_THRESHOLDS,
    });
    expect(message.type).toBe('hello');
  });

  it('rejects unknown message types', () => {
    expect(ServerMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });
});

describe('DEFAULT_STATUS_THRESHOLDS', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_STATUS_THRESHOLDS).toEqual({
      pollIntervalMs: 2000,
      staleAfterPolls: 3,
      cpuDegradedPercent: 90,
      cpuDegradedPolls: 3,
      memoryDegradedPercent: 90,
      diskDegradedPercent: 90,
    });
  });
});
