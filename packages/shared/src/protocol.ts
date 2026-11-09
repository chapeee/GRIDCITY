import { z } from 'zod';
import { HostSchema } from './host';
import { HostStateSchema } from './host-state';

/**
 * Version of the WebSocket protocol below. Bump on any breaking change so a
 * stale browser tab can tell the user to reload instead of misreading data.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Where the data comes from. Real and demo data are never mixed in one
 * session: the server picks one mode at startup and announces it in `hello`,
 * and the client shows a permanent "DEMO DATA" badge in demo mode.
 */
export const DataModeSchema = z.enum(['real', 'demo']);
export type DataMode = z.infer<typeof DataModeSchema>;

/** Messages the server sends on the state WebSocket. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  /** First message after connecting. */
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    dataMode: DataModeSchema,
    projectName: z.string(),
  }),
  /** Full picture: sent after `hello` and whenever the client asks to resync. */
  z.object({
    type: z.literal('snapshot'),
    hosts: z.array(HostSchema),
    states: z.array(HostStateSchema),
  }),
  /** Diff at host granularity: only hosts whose state changed. */
  z.object({
    type: z.literal('hostStates'),
    states: z.array(HostStateSchema),
  }),
  /** A host was removed from configuration. */
  z.object({
    type: z.literal('hostRemoved'),
    hostId: z.string(),
  }),
  /**
   * The server refused to connect because the host key is not in known_hosts
   * or does not match it. Never auto-accepted; the user must resolve it.
   */
  z.object({
    type: z.literal('hostKeyRefused'),
    hostId: z.string(),
    reason: z.enum(['unknown', 'changed']),
    /** SHA256 fingerprint of the key the host presented. */
    fingerprint: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Messages the client sends on the state WebSocket. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  /** Ask for a fresh `snapshot`, e.g. after the tab was in the background. */
  z.object({ type: z.literal('resync') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
