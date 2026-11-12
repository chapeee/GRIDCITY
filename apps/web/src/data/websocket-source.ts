import { ServerMessageSchema, type ClientMessage } from '@app/shared';
import type { HostDataSource } from './host-data-source';
import type { ServerLinkState } from './server-link';

export interface WebSocketSourceOptions {
  /** e.g. ws://127.0.0.1:4601/ws/state (derived from the page location by default). */
  url?: string;
  onLinkChange(state: ServerLinkState): void;
  /** Checks whether the session is still valid after a failed connect. */
  isSessionValid?: () => Promise<boolean>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** Keeps proxies from idling the socket out. */
const PING_INTERVAL_MS = 20_000;

/** The state socket next to the page (works through the Vite dev proxy too). */
export function stateSocketUrl(location: Location = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws/state`;
}

/** The session is valid when an authenticated endpoint answers 200. */
export async function checkSession(): Promise<boolean> {
  try {
    const response = await fetch('/api/meta', { credentials: 'same-origin' });
    // Only the session guard's answer means "new token needed". A proxy in front of a
    // restarting server (Vite in dev, nginx in production) answers 502/503: keep retrying.
    return response.status !== 401 && response.status !== 403;
  } catch {
    return true; // server unreachable: not a session problem, keep retrying
  }
}

/**
 * Live fleet data from the local server. Every message is validated against
 * the shared schema; anything malformed is dropped, never guessed at.
 * Reconnects with backoff; the browser hides HTTP status codes from failed
 * WebSocket upgrades, so a failed connect is followed by a session check.
 */
export function createWebSocketSource(options: WebSocketSourceOptions): HostDataSource {
  return {
    start(listener) {
      let socket: WebSocket | null = null;
      let attempt = 0;
      let stopped = false;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let pingTimer: ReturnType<typeof setInterval> | undefined;

      const send = (message: ClientMessage) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      };

      const connect = () => {
        if (stopped) return;
        const current = new WebSocket(options.url ?? stateSocketUrl());
        socket = current;
        let opened = false;

        current.addEventListener('open', () => {
          opened = true;
          attempt = 0;
          options.onLinkChange('open');
          pingTimer = setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);
        });

        current.addEventListener('message', (event) => {
          let data: unknown;
          try {
            data = JSON.parse(String(event.data));
          } catch {
            return;
          }
          const parsed = ServerMessageSchema.safeParse(data);
          if (parsed.success) listener(parsed.data);
          else console.warn('Ignoring malformed server message', parsed.error.issues);
        });

        current.addEventListener('close', async () => {
          clearInterval(pingTimer);
          if (stopped || socket !== current) return;
          if (!opened && !(await (options.isSessionValid ?? checkSession)())) {
            options.onLinkChange('unauthorized');
            return; // a new token is needed: retrying would never succeed
          }
          options.onLinkChange('reconnecting');
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt++);
          reconnectTimer = setTimeout(connect, delay);
        });
      };

      // When a backgrounded tab comes back, ask for a full picture.
      const onVisible = () => {
        if (document.visibilityState === 'visible') send({ type: 'resync' });
      };
      document.addEventListener('visibilitychange', onVisible);

      options.onLinkChange('connecting');
      connect();

      return () => {
        stopped = true;
        clearTimeout(reconnectTimer);
        clearInterval(pingTimer);
        document.removeEventListener('visibilitychange', onVisible);
        socket?.close();
      };
    },
  };
}
