import fastifyStatic from '@fastify/static';
import { PROTOCOL_VERSION } from '@app/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { existsSync } from 'node:fs';
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
  /** Built web client to serve in production. Omitted in development (Vite serves it). */
  webDistDir?: string;
  /** Pino logger options. Omit to disable logging (tests). */
  logger?: LoggerOptions;
}

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

/**
 * Builds the HTTP app without starting it, so tests can drive it with
 * `app.inject()`.
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ? withTokenRedaction(options.logger) : false });

  registerSessionGuard(app, options.sessionToken, options.port);

  app.get('/api/meta', async () => ({
    projectName: options.projectName,
    version: options.version,
    protocolVersion: PROTOCOL_VERSION,
  }));

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
 * Rejects every request that is not addressed to localhost or that lacks the
 * session token. The token may arrive as a `?token=` query parameter (the
 * printed URL), a `Bearer` header, or the cookie set after the first visit.
 */
function registerSessionGuard(app: FastifyInstance, sessionToken: string, port: number): void {
  const cookieName = sessionCookieName(port);

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHostHeader(request.headers.host)) {
      return reply.code(421).send({ error: 'This server only answers to localhost.' });
    }

    const query = request.query as Record<string, unknown> | undefined;
    const queryToken = query?.[TOKEN_QUERY_PARAM];
    if (typeof queryToken === 'string' && tokensMatch(sessionToken, queryToken)) {
      // Remember the session so assets and API calls work without the query string.
      reply.header(
        'set-cookie',
        `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
      );
      return;
    }

    const presented =
      readBearerToken(request.headers.authorization) ??
      readCookie(request.headers.cookie, cookieName);
    if (tokensMatch(sessionToken, presented)) return;

    return reply.code(401).send({
      error: 'Missing or invalid session token. Open the URL printed in the server console.',
    });
  });
}
