import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';

/**
 * Largest frame accepted from a browser. Terminal pastes can be sizeable;
 * state-socket control messages are tiny and validated separately.
 */
const MAX_CLIENT_FRAME_BYTES = 1024 * 1024;

/** Registers @fastify/websocket once, however many socket routes need it. */
export async function ensureWebSocketPlugin(app: FastifyInstance): Promise<void> {
  if (app.hasDecorator('websocketServer')) return;
  await app.register(websocket, { options: { maxPayload: MAX_CLIENT_FRAME_BYTES } });
}
