import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
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
import { certificateMetrics } from './http';
import { describeCertificate, type CertificateInfo } from './tls-info';

export interface TcpProbeResult {
  connectMs: number;
  /** First line the server sent on its own (SSH, SMTP, FTP banners), or null. */
  banner: string | null;
  certificate: CertificateInfo | null;
}

/** How long to wait for a banner after connecting; many services say nothing, which is fine. */
const BANNER_WAIT_MS = 1_500;

/**
 * A TCP port watched from this machine: can it be opened, how fast, what
 * does it say first, and (with `tls`) what certificate does it present.
 * Nothing is sent to the service except the TLS handshake when asked for.
 */
export function createTcpConnector(
  config: ResourceConfigOf<'tcp'>,
  context: ConnectorContext,
  probe: (config: ResourceConfigOf<'tcp'>, now: () => number) => Promise<TcpProbeResult> = probeTcp,
): Connector {
  const resource = singleResource(
    config,
    config.tls ? 'TCP · TLS' : 'TCP',
    `${config.host}:${config.port}`,
  );
  resource.district = config.district ?? 'Edge';

  const poll = async (): Promise<PollOutcome[]> => {
    let result: TcpProbeResult;
    try {
      result = await probe(config, context.now);
    } catch (error) {
      return [{ resourceId: resource.id, ok: false, error: (error as Error).message }];
    }
    if (config.expectBanner && !(result.banner ?? '').includes(config.expectBanner)) {
      return [
        {
          resourceId: resource.id,
          ok: false,
          error: result.banner
            ? `banner "${result.banner.slice(0, 60)}" does not contain "${config.expectBanner}"`
            : `no banner received (expected "${config.expectBanner}")`,
        },
      ];
    }
    const warnings =
      result.certificate && !result.certificate.trusted
        ? [`certificate not trusted (${result.certificate.problem})`]
        : [];
    return [
      {
        resourceId: resource.id,
        ok: true,
        sample: healthSample(
          { latencyMs: result.connectMs },
          { certificateDaysLeft: result.certificate?.daysLeft ?? null, warnings },
        ),
        metrics: [
          metric('latency', 'Connect time', 'ms', result.connectMs),
          textMetric('banner', 'Banner', result.banner ?? 'none (port open)'),
          ...certificateMetrics(result.certificate, config.tls),
        ],
      },
    ];
  };

  return { config, resources: () => [resource], poll, close: async () => undefined };
}

export function probeTcp(
  config: ResourceConfigOf<'tcp'>,
  now: () => number = Date.now,
): Promise<TcpProbeResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let settled = false;
    let connectMs = 0;
    let bannerTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(bannerTimer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`timed out after ${config.timeoutMs} ms`))),
      config.timeoutMs,
    );
    const onReady = (socket: Socket, certificate: CertificateInfo | null) => {
      connectMs = Math.round((performance.now() - startedAt) * 10) / 10;
      let banner = '';
      socket.on('data', (chunk: Buffer) => {
        banner += chunk.toString('utf8');
        if (banner.includes('\n') || banner.length > 512) {
          finish(() => resolve({ connectMs, banner: firstLine(banner), certificate }));
        }
      });
      bannerTimer = setTimeout(
        () => finish(() => resolve({ connectMs, banner: firstLine(banner), certificate })),
        BANNER_WAIT_MS,
      );
    };
    const socket: Socket = config.tls
      ? tlsConnect({
          host: config.host,
          port: config.port,
          servername: config.host,
          rejectUnauthorized: false,
        })
      : netConnect({ host: config.host, port: config.port });
    if (config.tls) {
      const tlsSocket = socket as import('node:tls').TLSSocket;
      tlsSocket.once('secureConnect', () =>
        onReady(
          tlsSocket,
          describeCertificate(
            tlsSocket.getPeerCertificate(),
            tlsSocket.authorized,
            tlsSocket.authorizationError,
            now(),
          ),
        ),
      );
    } else {
      socket.once('connect', () => onReady(socket, null));
    }
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(new Error(error.code ? `${error.code}: ${error.message}` : error.message)),
      ),
    );
  });
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/)[0]?.trim() ?? '';
  return line ? line : null;
}
