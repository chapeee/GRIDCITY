import fastifyStatic from '@fastify/static';
import { PROTOCOL_VERSION } from '@app/shared';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { existsSync } from 'node:fs';
import { isAllowedOrigin, requiresOriginCheck } from '../security/origin';
import {
  isAllowedHostHeader,
  readBearerToken,
  readCookie,
  redactTokenInUrl,
  sessionCookieName,
  TOKEN_QUERY_PARAM,
  tokensMatch,
} from '../security/session-token';

export interface CreateAppOptions {
  projectName: string;
  version: string;
  /** Session token every request must present. */
  sessionToken: string;
  /** Port the server listens on; scopes the session cookie. */
  port: number;
  /** Origins allowed for WebSocket upgrades and state-changing requests. */
  allowedOrigins: ReadonlySet<string>;
  /** Built web client to serve in production. Omitted in development (Vite serves it). */
  webDistDir?: string;
  /** Pino logger options. Omit to disable logging (tests). */
  logger?: LoggerOptions;
  /** Registers feature routes (WebSocket, API) after the security hooks. */
  registerRoutes?: (app: FastifyInstance) => Promise<void>;
}

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

/**
 * Builds the HTTP app without starting it, so tests can drive it with
 * `app.inject()`.
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ? withTokenRedaction(options.logger) : false,
    // Close idle and half-open sockets (e.g. refused upgrades) so shutdown never hangs.
    forceCloseConnections: true,
  });

  registerSecurityGuard(app, options.sessionToken, options.port, options.allowedOrigins);

  app.get('/api/meta', async () => ({
    projectName: options.projectName,
    version: options.version,
    protocolVersion: PROTOCOL_VERSION,
  }));

  await options.registerRoutes?.(app);

  if (options.webDistDir && existsSync(options.webDistDir)) {
    await app.register(fastifyStatic, { root: options.webDistDir });
    // Single-page app: unknown non-API GET routes fall back to index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}

/**
 * Fastify logs every request URL. The first page load carries `?token=`, so
 * the request serializer redacts it before anything reaches a log line.
 */
function withTokenRedaction(logger: LoggerOptions): LoggerOptions {
  return {
    ...logger,
    serializers: {
      ...logger.serializers,
      req: (request: { method?: string; url?: string }) => ({
        method: request.method,
        url: request.url === undefined ? undefined : redactTokenInUrl(request.url),
      }),
    },
  };
}

/**
 * Every request must:
 * 1. be addressed to localhost (Host header; blocks DNS rebinding),
 * 2. carry the session token: `?token=` (the printed URL), a `Bearer`
 *    header, or the cookie set after the first visit,
 * 3. come from our own page (Origin) if it is a WebSocket upgrade or a write.
 *
 * Plain HTTP requests are checked in `onRequest`, before anything else runs.
 * WebSocket upgrades are checked in `preValidation`: @fastify/websocket
 * requires upgrade refusals there, otherwise the refused socket is left
 * half-open and server shutdown hangs.
 */
function registerSecurityGuard(
  app: FastifyInstance,
  sessionToken: string,
  port: number,
  allowedOrigins: ReadonlySet<string>,
): void {
  const cookieName = sessionCookieName(port);
  const isUpgrade = (request: FastifyRequest) =>
    request.headers.upgrade?.toLowerCase() === 'websocket';

  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAllowedHostHeader(request.headers.host)) {
      return reply.code(421).send({ error: 'This server only answers to localhost.' });
    }

    const query = request.query as Record<string, unknown> | undefined;
    const queryToken = query?.[TOKEN_QUERY_PARAM];
    const hasQueryToken = typeof queryToken === 'string' && tokensMatch(sessionToken, queryToken);
    const presented =
      readBearerToken(request.headers.authorization) ??
      readCookie(request.headers.cookie, cookieName);
    if (!hasQueryToken && !tokensMatch(sessionToken, presented)) {
      return reply.code(401).send({
        error: 'Missing or invalid session token. Open the URL printed in the server console.',
      });
    }

    if (
      requiresOriginCheck(request.method, request.headers.upgrade) &&
      !isAllowedOrigin(request.headers.origin, allowedOrigins)
    ) {
      return reply.code(403).send({ error: 'Origin not allowed.' });
    }

    if (hasQueryToken) {
      // Remember the session so assets and API calls work without the query string.
      reply.header(
        'set-cookie',
        `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
      );
    }
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!isUpgrade(request)) return guard(request, reply);
  });
  app.addHook('preValidation', async (request, reply) => {
    if (isUpgrade(request)) return guard(request, reply);
  });
}
