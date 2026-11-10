import { TerminalServerMessageSchema, type TerminalServerMessage } from '@app/shared';

/** What the terminal screen shows in its header. */
export type TerminalStatus =
  | 'connecting'
  | 'connected'
  | 'ended'
  | 'disconnected'
  | 'failed'
  /** Demo data: there is no real shell to connect to. Not an error. */
  | 'demo';

export interface TerminalSessionHandlers {
  onOutput(bytes: Uint8Array): void;
  onControl(message: TerminalServerMessage): void;
  /** The socket closed without an `exit` or `error` message first. */
  onUnexpectedClose(): void;
}

export interface TerminalSessionHandle {
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** The terminal socket next to the page (works through the Vite dev proxy too). */
export function terminalSocketUrl(hostId: string, location: Location = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws/terminal/${encodeURIComponent(hostId)}`;
}

/**
 * One terminal connection: keystrokes go out as binary frames, output comes
 * back as binary, control messages are validated JSON.
 */
export function openTerminalSession(
  hostId: string,
  size: { cols: number; rows: number },
  handlers: TerminalSessionHandlers,
): TerminalSessionHandle {
  const socket = new WebSocket(terminalSocketUrl(hostId));
  socket.binaryType = 'arraybuffer';
  const encoder = new TextEncoder();
  let finished = false;

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', ...size }));
  });
  socket.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      handlers.onOutput(new Uint8Array(event.data));
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = TerminalServerMessageSchema.safeParse(data);
    if (!parsed.success) return;
    if (parsed.data.type !== 'ready') finished = true;
    handlers.onControl(parsed.data);
  });
  socket.addEventListener('close', () => {
    if (!finished) handlers.onUnexpectedClose();
  });

  return {
    sendInput(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    },
    resize(cols, rows) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    },
    close() {
      finished = true;
      socket.close();
    },
  };
}
