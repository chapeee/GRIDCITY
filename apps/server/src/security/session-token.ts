import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Query parameter carrying the token in the URL printed at startup. */
export const TOKEN_QUERY_PARAM = 'token';

/** 256 bits of randomness, URL-safe. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The token kept in the data folder (readable only by this user), so the
 * printed link and the browser cookie keep working across restarts. Pass
 * `rotate` (`--new-token`) to replace it, which signs out every browser.
 */
export function loadOrCreateSessionToken(file: string, options: { rotate?: boolean } = {}): string {
  if (!options.rotate) {
    try {
      const saved = readFileSync(file, 'utf8').trim();
      if (TOKEN_PATTERN.test(saved)) return saved;
    } catch {
      // first start, or unreadable: make a new one
    }
  }
  const token = createSessionToken();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${token}
`,
    { mode: 0o600 },
  );
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort on Windows, where the user profile is already private
  }
  return token;
}

/** Constant-time comparison so response timing does not leak the token. */
export function tokensMatch(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes)
  );
}

/**
 * Cookie name scoped by port. Browsers share cookies across ports on the same
 * host, so two local tools on 127.0.0.1 must not overwrite each other.
 */
export function sessionCookieName(port: number): string {
  return `session_token_${port}`;
}

/** Reads one cookie value from a raw `Cookie` header. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Extracts a `Bearer` token from an `Authorization` header. */
export function readBearerToken(authorizationHeader: string | undefined): string | undefined {
  const prefix = 'Bearer ';
  return authorizationHeader?.startsWith(prefix)
    ? authorizationHeader.slice(prefix.length)
    : undefined;
}

/** Replaces the token in a URL so it never ends up in logs. */
export function redactTokenInUrl(url: string): string {
  return url.replace(new RegExp(`([?&]${TOKEN_QUERY_PARAM}=)[^&#]*`, 'g'), '$1[redacted]');
}

/** Host header values we answer to. Blocks DNS-rebinding attacks. */
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True when the `Host` header names this machine (any port). */
export function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return hostname !== undefined && ALLOWED_HOSTNAMES.has(hostname.toLowerCase());
}
