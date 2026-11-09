import websocket from '@fastify/websocket';
import { ClientMessageSchema, type ServerMessage } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import type { StateHub } from '../fleet/state-hub';

/** Largest client message accepted; clients only send tiny control messages. */
const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024;

/**
 * `GET /ws/state`: the live fleet stream (see packages/shared/src/protocol.ts).
 * Token and Origin are enforced by the app-wide hooks before the upgrade.
 */
export async function registerStateSocket(app: FastifyInstance, hub: StateHub): Promise<void> {
  await app.register(websocket, { options: { maxPayload: MAX_CLIENT_MESSAGE_BYTES } });

  app.get('/ws/state', { websocket: true }, (socket) => {
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const unsubscribe = hub.subscribe(send);

    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return send({ type: 'error', message: 'Messages must be JSON.' });
      }
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) return send({ type: 'error', message: 'Unknown message.' });
      if (result.data.type === 'resync') hub.sendSnapshot(send);
      // 'ping' needs no reply: receiving it keeps intermediaries from idling out.
    });

    socket.on('close', unsubscribe);
  });
}
