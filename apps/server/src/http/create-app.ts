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

/**
 * The token never changes unless the user asks (--new-token), so the cookie
 * lives as long as browsers allow (400 days) and is renewed on every page load:
 * a browser that keeps using GRIDCITY never has to open the link again.
 */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** Query field of the "paste your link" form on the page shown without a key. */
const LINK_QUERY_PARAM = 'link';

/** The token in a pasted link ("http://127.0.0.1:4600/?token=…") or a bare token. */
export function tokenFromLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^[A-Za-z0-9_-]{16,128}$/.test(text)) return text;
  try {
    return new URL(text, 'http://127.0.0.1/').searchParams.get(TOKEN_QUERY_PARAM) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a browser sees without a valid key: why, where the link is, and a box
 * to paste it. Static text: nothing the visitor sent is ever echoed back.
 */
function noKeyPage(projectName: string, wrongLink: boolean): string {
  const name = projectName.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}: open your link</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050708;color:#cfe9f2;font:15px/1.5 system-ui,sans-serif}
  main{max-width:560px;padding:24px}
  h1{font-size:20px;color:#8fe3ff;margin:0 0 12px}
  code{background:#0d1418;padding:1px 6px;border-radius:3px;color:#8fe3ff}
  form{display:flex;gap:8px;margin:18px 0 8px}
  input{flex:1;padding:9px 10px;background:#0d1418;color:#e6f6fb;border:1px solid #1f4250;border-radius:4px;font:inherit}
  button{padding:9px 14px;background:#00e5ff;color:#02181d;border:0;border-radius:4px;font:inherit;font-weight:600;cursor:pointer}
  .wrong{color:#ffb86b}
  .small{color:#7f9aa5;font-size:13px}
</style></head>
<body><main>
  <h1>Open ${name} with its link</h1>
  <p>${name} only answers this computer, and only with the key in its link, so other websites
  you visit cannot reach your servers through it.</p>
  ${wrongLink ? '<p class="wrong">That link does not belong to this GRIDCITY: it has its own key. Was it started elsewhere (Docker, another folder)?</p>' : ''}
  <form method="get" action="/">
    <input name="${LINK_QUERY_PARAM}" placeholder="http://127.0.0.1:4600/?token=…" autocomplete="off" autofocus aria-label="Your ${name} link">
    <button type="submit">Open</button>
  </form>
  <p class="small">Where is the link? <code>gridcity status</code> prints it, Docker prints it in
  <code>docker logs gridcity</code>, and the desktop app opens it for you. This browser then
  remembers it.</p>
</main></body></html>`;
}

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
  /** Extra fields for /api/meta (e.g. data mode, hosts.yaml location). */
  describe?: () => Record<string, unknown>;
  /**
   * Paths local programs call with the token as a Bearer header and no
   * Origin (the MCP endpoint, for Claude Code and other AI apps). Every
   * other path keeps requiring our Origin on writes.
   */
  programPaths?: readonly string[];
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

  registerSecurityGuard(
    app,
    options.projectName,
    options.sessionToken,
    options.port,
    options.allowedOrigins,
    new Set(options.programPaths ?? []),
  );

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/meta', async () => ({
    projectName: options.projectName,
    version: options.version,
    protocolVersion: PROTOCOL_VERSION,
    ...options.describe?.(),
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
  projectName: string,
  sessionToken: string,
  port: number,
  allowedOrigins: ReadonlySet<string>,
  programPaths: ReadonlySet<string>,
): void {
  const cookieName = sessionCookieName(port);
  const isUpgrade = (request: FastifyRequest) =>
    request.headers.upgrade?.toLowerCase() === 'websocket';

  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAllowedHostHeader(request.headers.host)) {
      return reply.code(421).send({ error: 'This server only answers to localhost.' });
    }
    // Liveness for Docker and process managers: says nothing but "up".
    if (request.method === 'GET' && request.url === '/healthz') return;

    const query = request.query as Record<string, unknown> | undefined;
    // A link pasted into the page shown without a key (GET only: it is a navigation).
    const pastedLink = request.method === 'GET' && query?.[LINK_QUERY_PARAM] !== undefined;
    const queryToken = pastedLink
      ? tokenFromLink(query?.[LINK_QUERY_PARAM])
      : query?.[TOKEN_QUERY_PARAM];
    const hasQueryToken = typeof queryToken === 'string' && tokensMatch(sessionToken, queryToken);
    const bearer = readBearerToken(request.headers.authorization);
    const cookieToken = readCookie(request.headers.cookie, cookieName);
    const presented = bearer ?? cookieToken;
    const pageLoad =
      request.method === 'GET' &&
      !isUpgrade(request) &&
      /text\/html/.test(request.headers.accept ?? '');
    if (!hasQueryToken && !tokensMatch(sessionToken, presented)) {
      // A person opening the page gets an explanation and a place to paste the link.
      if (pageLoad) {
        return reply
          .code(401)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .header(
            'content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          )
          .send(noKeyPage(projectName, pastedLink));
      }
      return reply.code(401).send({
        error: 'Missing or invalid session token. Open the URL printed in the server console.',
      });
    }

    // Programs (AI apps calling /mcp) send the token as a Bearer header and no
    // Origin. A web page cannot do that: browsers always send Origin on writes,
    // and a cross-site page cannot set Authorization without CORS, which this
    // server never allows. Accepted on the program paths only.
    const localProgram =
      bearer !== undefined &&
      request.headers.origin === undefined &&
      programPaths.has(request.url.split('?')[0] ?? '');
    if (
      requiresOriginCheck(request.method, request.headers.upgrade) &&
      !localProgram &&
      !isAllowedOrigin(request.headers.origin, allowedOrigins)
    ) {
      return reply.code(403).send({ error: 'Origin not allowed.' });
    }

    const rememberSession = () =>
      reply.header(
        'set-cookie',
        `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
      );
    if (hasQueryToken) {
      // Remember the session so assets and API calls work without the query string.
      rememberSession();
      // A pasted link: continue at the city, without the link in the address bar.
      if (pastedLink) return reply.redirect('/', 302);
    } else if (pageLoad && cookieToken !== undefined && bearer === undefined) {
      // Every page load renews the cookie: a browser in use never needs the link again.
      rememberSession();
    }
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!isUpgrade(request)) return guard(request, reply);
  });
  app.addHook('preValidation', async (request, reply) => {
    if (isUpgrade(request)) return guard(request, reply);
  });
}
