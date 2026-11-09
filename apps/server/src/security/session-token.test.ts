import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  isAllowedHostHeader,
  readBearerToken,
  readCookie,
  redactTokenInUrl,
  tokensMatch,
} from './session-token';

describe('createSessionToken', () => {
  it('creates distinct, URL-safe tokens', () => {
    const a = createSessionToken();
    const b = createSessionToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('tokensMatch', () => {
  it('matches identical tokens only', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('abc', undefined)).toBe(false);
  });
});

describe('readCookie', () => {
  it('finds a cookie among others', () => {
    expect(readCookie('a=1; session_token_4600=xyz; b=2', 'session_token_4600')).toBe('xyz');
  });

  it('returns undefined when absent or malformed', () => {
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('x=%E0%A4%A', 'x')).toBeUndefined();
  });
});

describe('readBearerToken', () => {
  it('reads Bearer tokens only', () => {
    expect(readBearerToken('Bearer abc')).toBe('abc');
    expect(readBearerToken('Basic abc')).toBeUndefined();
  });
});

describe('redactTokenInUrl', () => {
  it('hides the token value', () => {
    expect(redactTokenInUrl('/?token=secret&x=1')).toBe('/?token=[redacted]&x=1');
    expect(redactTokenInUrl('/a?x=1&token=secret')).toBe('/a?x=1&token=[redacted]');
  });

  it('leaves URLs without a token untouched', () => {
    expect(redactTokenInUrl('/api/meta')).toBe('/api/meta');
  });
});

describe('isAllowedHostHeader', () => {
  it.each(['127.0.0.1:4600', 'localhost:5173', 'LOCALHOST', '[::1]:4600'])('allows %s', (host) => {
    expect(isAllowedHostHeader(host)).toBe(true);
  });

  it.each([undefined, 'evil.example:4600', '192.168.1.5:4600', 'localhost.evil.example'])(
    'rejects %s',
    (host) => {
      expect(isAllowedHostHeader(host)).toBe(false);
    },
  );
});
