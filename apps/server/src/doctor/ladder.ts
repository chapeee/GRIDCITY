import type { LadderStep } from '@app/shared';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { readCertificate } from '../connectors/tls-info';

/**
 * The connection ladder: resolve the name, open the port, (where the
 * protocol starts with TLS) shake hands. Each rung either works or says
 * exactly why not, so "could not connect" becomes "DNS works, port 3306 is
 * open, the server refused the login". Read-only and cheap: one lookup, one
 * TCP connect, at most one TLS handshake, no data sent.
 */
export interface Endpoint {
  host: string;
  port: number;
  /** The protocol starts with a TLS handshake (HTTPS, Redis/Mongo TLS, TLS TCP probes). */
  rawTls: boolean;
}

export interface LadderOptions {
  timeoutMs?: number;
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  tcp?: (host: string, port: number, timeoutMs: number) => Promise<number>;
}

export interface LadderResult {
  steps: LadderStep[];
  addresses: string[];
  /** The first rung that failed, or null when everything up to the protocol worked. */
  failedAt: LadderStep['step'] | null;
}

const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function addressScope(address: string): 'loopback' | 'private' | 'public' {
  if (address === '::1' || address.startsWith('127.')) return 'loopback';
  if (
    PRIVATE_V4.some((pattern) => pattern.test(address)) ||
    /^f[cd]/i.test(address) ||
    /^fe80:/i.test(address)
  ) {
    return 'private';
  }
  return 'public';
}

/** True inside a container (Docker, Podman), where "localhost" is the container itself. */
export function runningInContainer(): boolean {
  return (
    existsSync('/.dockerenv') ||
    existsSync('/run/.containerenv') ||
    process.env.BIND_INSIDE_CONTAINER === 'true'
  );
}

export async function climbLadder(
  endpoint: Endpoint,
  options: LadderOptions = {},
): Promise<LadderResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const steps: LadderStep[] = [];
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true }));
  const tcp = options.tcp ?? tcpConnect;

  // 1. DNS
  let addresses: string[] = [];
  const dnsStart = performance.now();
  try {
    addresses = (await resolve(endpoint.host)).map((entry) => entry.address);
    const scopes = [...new Set(addresses.map(addressScope))];
    steps.push({
      step: 'dns',
      status: 'ok',
      detail: `${endpoint.host} → ${addresses.slice(0, 3).join(', ')}${addresses.length > 3 ? '…' : ''} (${scopes.join(', ')})`,
      ms: round(performance.now() - dnsStart),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    steps.push({
      step: 'dns',
      status: 'failed',
      detail: `${endpoint.host} does not resolve (${code})`,
      ms: round(performance.now() - dnsStart),
    });
    return finish(steps, addresses, endpoint);
  }

  // 2. TCP
  const target = addresses[0] ?? endpoint.host;
  try {
    const ms = await tcp(target, endpoint.port, timeoutMs);
    steps.push({
      step: 'tcp',
      status: 'ok',
      detail: `port ${endpoint.port} open in ${round(ms)} ms`,
      ms: round(ms),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    const detail =
      code === 'ECONNREFUSED'
        ? `port ${endpoint.port} refused: nothing listens there, or a firewall rejects it`
        : code === 'ETIMEDOUT' || /timed out/i.test(String(code))
          ? `port ${endpoint.port} did not answer within ${timeoutMs} ms: a firewall or security group drops it, or the host is down`
          : `port ${endpoint.port}: ${code}`;
    steps.push({ step: 'tcp', status: 'failed', detail, ms: null });
    return finish(steps, addresses, endpoint);
  }

  // 3. TLS (only for protocols that start with it; MySQL/Postgres negotiate it inside)
  if (endpoint.rawTls) {
    const certificate = await readCertificate(endpoint.host, endpoint.port, { timeoutMs });
    if (!certificate) {
      steps.push({
        step: 'tls',
        status: 'failed',
        detail:
          'no TLS handshake: the port speaks plain text (turn TLS off), or TLS needs a different port',
        ms: null,
      });
    } else {
      const expiring = certificate.daysLeft < 0 ? 'EXPIRED' : `${certificate.daysLeft} days left`;
      steps.push({
        step: 'tls',
        status: certificate.trusted && certificate.daysLeft >= 0 ? 'ok' : 'warning',
        detail: `${certificate.issuer ?? 'unknown issuer'} · ${expiring}${certificate.trusted ? '' : ` · not trusted: ${certificate.problem}`}`,
        ms: null,
      });
    }
  } else {
    steps.push({
      step: 'tls',
      status: 'skipped',
      detail: 'negotiated inside the protocol (checked at login)',
      ms: null,
    });
  }
  return finish(steps, addresses, endpoint);
}

function finish(steps: LadderStep[], addresses: string[], _endpoint: Endpoint): LadderResult {
  const failed = steps.find((step) => step.status === 'failed');
  return { steps, addresses, failedAt: failed?.step ?? null };
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(performance.now() - started);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const round = (value: number) => Math.round(value * 10) / 10;
