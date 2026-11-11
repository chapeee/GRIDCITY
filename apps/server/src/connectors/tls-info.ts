import { connect, type PeerCertificate } from 'node:tls';

/** What a TLS handshake tells about a server's certificate, for probes. */
export interface CertificateInfo {
  /** Whole days until `validTo`; negative when expired. */
  daysLeft: number;
  validTo: string;
  issuer: string | null;
  subject: string | null;
  /** False when the chain is not trusted (self-signed, wrong name, expired). */
  trusted: boolean;
  /** Why it is not trusted, from Node's verification. */
  problem: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Connects, reads the peer certificate and hangs up. Verification failures
 * are reported, never fatal: an expiring self-signed certificate is still
 * worth knowing about. Sends no data beyond the handshake.
 */
export function readCertificate(
  host: string,
  port: number,
  options: { servername?: string; timeoutMs?: number; now?: () => number } = {},
): Promise<CertificateInfo | null> {
  const now = options.now ?? Date.now;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: CertificateInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = connect({
      host,
      port,
      servername: options.servername ?? host,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 5_000);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      finish(describeCertificate(certificate, socket.authorized, socket.authorizationError, now()));
    });
    socket.once('error', () => finish(null));
  });
}

export function describeCertificate(
  certificate: PeerCertificate | undefined,
  authorized: boolean,
  authorizationError: Error | string | null | undefined,
  now: number,
): CertificateInfo | null {
  if (!certificate || !certificate.valid_to) return null;
  const validTo = new Date(certificate.valid_to).getTime();
  if (!Number.isFinite(validTo)) return null;
  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  const name = (subject: PeerCertificate['subject'] | undefined) =>
    subject
      ? (first(subject.O) ?? first(subject.CN) ?? first(Object.values(subject)[0]) ?? null)
      : null;
  return {
    daysLeft: Math.floor((validTo - now) / DAY_MS),
    validTo: new Date(validTo).toISOString(),
    issuer: name(certificate.issuer),
    subject: first(certificate.subject?.CN) ?? name(certificate.subject),
    trusted: authorized,
    problem: authorized
      ? null
      : typeof authorizationError === 'string'
        ? authorizationError
        : (authorizationError?.message ?? 'not trusted'),
  };
}
