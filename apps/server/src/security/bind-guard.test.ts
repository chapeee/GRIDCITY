import { describe, expect, it } from 'vitest';
import { decideBind } from './bind-guard';

describe('decideBind', () => {
  it.each(['127.0.0.1', '::1'])('allows loopback address %s', (host) => {
    expect(decideBind(host, false)).toEqual({ allowed: true });
  });

  it('refuses 0.0.0.0 outside a container', () => {
    expect(decideBind('0.0.0.0', false).allowed).toBe(false);
  });

  it('allows 0.0.0.0 inside a container, with a warning', () => {
    const decision = decideBind('0.0.0.0', true);
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.warning).toBeTruthy();
  });

  it('refuses a LAN address even inside a container', () => {
    expect(decideBind('192.168.1.10', true).allowed).toBe(false);
  });
});
