import type { ServerMessage } from '@app/shared';

export type ServerMessageListener = (message: ServerMessage) => void;

/**
 * Where fleet data comes from. The demo source runs in the browser today;
 * the WebSocket source (Phase 3) will implement the same interface, so the
 * store and the 3D world never know which one is active.
 */
export interface HostDataSource {
  /** Starts streaming messages to `listener`. Returns a function that stops it. */
  start(listener: ServerMessageListener): () => void;
}
