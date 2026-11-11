import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ResourceConfigOf } from '../config/resources-file';
import {
  healthSample,
  metric,
  singleResource,
  textMetric,
  type Connector,
  type ConnectorContext,
  type PollOutcome,
} from './connector';
import { readCertificate, type CertificateInfo } from './tls-info';

/** Body kept for `expectBody` and the size metric; the rest is drained and dropped. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface HttpProbeResult {
  status: number;
  statusText: string;
  /** Request start to last byte, ms. */
  totalMs: number;
  /** Request start to response headers, ms. */
  firstByteMs: number;
  bodyBytes: number;
  body: string;
  finalUrl: string;
  redirects: number;
}

/**
 * An HTTP(S) endpoint watched from this machine, with Node's own http
 * modules (no dependency, full control over redirects, TLS and timing).
 * A status outside what is expected, a missing body text, a timeout or a
 * connection error all count as unreachable: that is what a user of the
 * endpoint would see. The certificate is read in a separate handshake so
 * its expiry shows even when the request itself fails.
 */
export function createHttpConnector(
  config: ResourceConfigOf<'http'>,
  context: ConnectorContext,
  probe: (config: ResourceConfigOf<'http'>) => Promise<HttpProbeResult> = probeHttp,
): Connector {
  const url = new URL(config.url);
  const tls = url.protocol === 'https:';
  const resource = singleResource(config, tls ? 'HTTPS' : 'HTTP', config.url);
  resource.district = config.district ?? 'Edge';

  const poll = async (): Promise<PollOutcome[]> => {
    const [outcome, certificate] = await Promise.all([
      probe(config).then(
        (result) => ({ ok: true as const, result }),
        (error: Error) => ({ ok: false as const, error: error.message }),
      ),
      tls
        ? readCertificate(url.hostname, Number(url.port) || 443, {
            timeoutMs: config.timeoutMs,
            now: context.now,
          })
        : Promise.resolve(null),
    ]);
    const certMetrics = certificateMetrics(certificate, tls);

    if (!outcome.ok) {
      return [{ resourceId: resource.id, ok: false, error: outcome.error }];
    }
    const { result } = outcome;
    const problem = statusProblem(result, config);
    if (problem) return [{ resourceId: resource.id, ok: false, error: problem }];

    const warnings: string[] = [];
    if (certificate && !certificate.trusted && !config.insecure) {
      warnings.push(`certificate not trusted (${certificate.problem})`);
    }
    return [
      {
        resourceId: resource.id,
        ok: true,
        sample: healthSample(
          { latencyMs: result.totalMs },
          { certificateDaysLeft: certificate?.daysLeft ?? null, warnings },
        ),
        metrics: [
          metric('status', 'HTTP status', 'count', result.status),
          metric('latency', 'Round trip', 'ms', result.totalMs),
          metric('ttfb', 'Time to first byte', 'ms', result.firstByteMs),
          metric('size', 'Body', 'bytes', result.bodyBytes),
          metric('redirects', 'Redirects', 'count', result.redirects),
          ...(result.redirects > 0 ? [textMetric('finalUrl', 'Final URL', result.finalUrl)] : []),
          ...certMetrics,
        ],
      },
    ];
  };

  return { config, resources: () => [resource], poll, close: async () => undefined };
}

export function certificateMetrics(certificate: CertificateInfo | null, tls: boolean) {
  if (!tls) return [];
  return [
    metric('certDays', 'Certificate expires in', 'days', certificate?.daysLeft ?? null),
    textMetric(
      'issuer',
      'Certificate issuer',
      certificate ? (certificate.issuer ?? 'unknown') : 'could not read certificate',
    ),
    ...(certificate && !certificate.trusted
      ? [textMetric('certProblem', 'Certificate problem', certificate.problem)]
      : []),
  ];
}

/** Why a response does not count as healthy, or null. */
export function statusProblem(
  result: Pick<HttpProbeResult, 'status' | 'statusText' | 'body'>,
  config: Pick<ResourceConfigOf<'http'>, 'expectStatus' | 'expectBody' | 'method'>,
): string | null {
  const expected = config.expectStatus;
  const okStatus = expected
    ? result.status === expected
    : result.status >= 200 && result.status < 400;
  if (!okStatus) {
    return `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}${expected ? ` (expected ${expected})` : ''}`;
  }
  if (config.expectBody && config.method !== 'HEAD' && !result.body.includes(config.expectBody)) {
    return `body does not contain "${config.expectBody}"`;
  }
  return null;
}

/** One request, following redirects by hand so each hop obeys the timeout. */
export async function probeHttp(config: ResourceConfigOf<'http'>): Promise<HttpProbeResult> {
  const startedAt = performance.now();
  const deadline = startedAt + config.timeoutMs;
  let url = new URL(config.url);
  let redirects = 0;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`timed out after ${config.timeoutMs} ms`);
    const response = await requestOnce(url, config, remaining);
    const location = response.headers.location;
    if (
      config.followRedirects &&
      location &&
      response.status >= 300 &&
      response.status < 400 &&
      redirects < MAX_REDIRECTS
    ) {
      await response.drain();
      url = new URL(location, url);
      redirects += 1;
      continue;
    }
    const firstByteMs = response.headersAt - startedAt;
    const { body, bytes } = await response.read();
    return {
      status: response.status,
      statusText: response.statusText,
      totalMs: round(performance.now() - startedAt),
      firstByteMs: round(firstByteMs),
      bodyBytes: bytes,
      body,
      finalUrl: url.toString(),
      redirects,
    };
  }
}

interface OneResponse {
  status: number;
  statusText: string;
  headers: IncomingMessage['headers'];
  headersAt: number;
  read(): Promise<{ body: string; bytes: number }>;
  drain(): Promise<void>;
}

function requestOnce(
  url: URL,
  config: ResourceConfigOf<'http'>,
  timeoutMs: number,
): Promise<OneResponse> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: config.method,
        headers: { 'user-agent': 'gridcity-probe/1 (+local)', accept: '*/*' },
        rejectUnauthorized: !config.insecure,
        timeout: timeoutMs,
      },
      (response) => {
        const headersAt = performance.now();
        const consume = (keep: boolean) =>
          new Promise<{ body: string; bytes: number }>((done, fail) => {
            let bytes = 0;
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (keep && bytes <= MAX_BODY_BYTES) chunks.push(chunk);
            });
            response.on('end', () => done({ body: Buffer.concat(chunks).toString('utf8'), bytes }));
            response.on('error', fail);
          });
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: response.headers,
          headersAt,
          read: () => consume(config.method !== 'HEAD'),
          drain: () => consume(false).then(() => undefined),
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${config.timeoutMs} ms`)));
    req.on('error', (error: NodeJS.ErrnoException) =>
      reject(new Error(error.code ? `${error.code}: ${error.message}` : error.message)),
    );
    req.end();
  });
}

const round = (value: number) => Math.round(value * 10) / 10;
