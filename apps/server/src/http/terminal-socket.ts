import { TerminalClientMessageSchema, type TerminalServerMessage } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import type { ClientChannel } from 'ssh2';
import type { HostConnection } from '../ssh/host-connection';
import type { AuditLog } from '../storage/audit-log';
import { ensureWebSocketPlugin } from './websocket-plugin';

export type TerminalTarget =
  { kind: 'connection'; connection: HostConnection } | { kind: 'unavailable'; message: string };

export interface TerminalDependencies {
  /** Finds the live SSH connection for a host, or explains why there is none. */
  resolve(hostId: string): TerminalTarget;
  audit?: AuditLog;
}

/** How long a client has to send `open` after connecting. */
const OPEN_TIMEOUT_MS = 5000;
/** Pause the shell when this much output is waiting to be sent to a slow browser. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;

/**
 * `GET /ws/terminal/:hostId`: an interactive shell (PTY) on the host's
 * existing SSH connection, bridged to the browser. Token and Origin are
 * enforced by the app-wide guard before the upgrade.
 *
 * Audited: session opened and closed, with host and duration. Keystrokes and
 * commands are NOT recorded (not reliably possible in a PTY, and not claimed).
 */
export async function registerTerminalSocket(
  app: FastifyInstance,
  deps: TerminalDependencies,
): Promise<void> {
  await ensureWebSocketPlugin(app);

  app.get<{ Params: { hostId: string } }>(
    '/ws/terminal/:hostId',
    { websocket: true },
    (socket, request) => {
      const { hostId } = request.params;
      let channel: ClientChannel | null = null;
      let opening = false;
      let socketClosed = false;
      let openedAt = 0;
      let exit: { code: number | null; signal: string | null } = { code: null, signal: null };

      const sendControl = (message: TerminalServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };
      const fail = (message: string) => {
        sendControl({ type: 'error', message });
        socket.close(1000);
      };
      const openTimer = setTimeout(
        () => fail('The terminal was not opened in time.'),
        OPEN_TIMEOUT_MS,
      );

      const sendOutput = (chunk: Buffer) => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(chunk, { binary: true });
        // Simple backpressure: stop reading from the shell while the browser catches up.
        if (channel && socket.bufferedAmount > HIGH_WATER_BYTES) {
          channel.pause();
          const resume = setInterval(() => {
            if (socket.readyState !== socket.OPEN || socket.bufferedAmount < HIGH_WATER_BYTES / 4) {
              clearInterval(resume);
              channel?.resume();
            }
          }, 50);
        }
      };

      const open = async (size: { cols: number; rows: number }) => {
        if (channel || opening) return;
        opening = true;
        clearTimeout(openTimer);

        const target = deps.resolve(hostId);
        if (target.kind === 'unavailable') return fail(target.message);
        if (target.connection.phase !== 'connected') {
          return fail(`${hostId} is not connected, so there is no shell to open.`);
        }

        let opened: ClientChannel;
        try {
          opened = await target.connection.openShell(size);
        } catch (error) {
          return fail(`Could not open a shell on ${hostId}: ${(error as Error).message}`);
        }
        if (socketClosed) {
          opened.close();
          return;
        }

        channel = opened;
        openedAt = Date.now();
        deps.audit?.append('terminal_opened', hostId, `${size.cols}x${size.rows}`);
        sendControl({ type: 'ready' });

        opened.on('data', sendOutput);
        opened.stderr.on('data', sendOutput);
        opened.on('exit', (code: number | null, signal?: string) => {
          exit = { code: typeof code === 'number' ? code : null, signal: signal ?? null };
        });
        opened.on('close', () => {
          channel = null;
          sendControl({ type: 'exit', ...exit });
          socket.close(1000);
        });
      };

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          channel?.write(data);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }
        const result = TerminalClientMessageSchema.safeParse(parsed);
        if (!result.success) return;
        const message = result.data;
        if (message.type === 'open') void open(message);
        else channel?.setWindow(message.rows, message.cols, 0, 0);
      });

      socket.on('close', () => {
        socketClosed = true;
        clearTimeout(openTimer);
        channel?.close();
        if (openedAt > 0) {
          const seconds = Math.round((Date.now() - openedAt) / 1000);
          deps.audit?.append('terminal_closed', hostId, `after ${seconds}s`);
          openedAt = 0;
        }
      });
    },
  );
}
