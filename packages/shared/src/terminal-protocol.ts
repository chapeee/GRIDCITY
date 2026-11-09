import { z } from 'zod';

/**
 * Terminal WebSocket protocol (`/ws/terminal/:hostId`), separate from the
 * state stream. Keystrokes and output travel as *binary* frames (raw bytes,
 * so any encoding and control sequence passes through untouched); control
 * messages are small JSON text frames.
 */

/** Terminal size limits, so a malicious client cannot request absurd PTYs. */
const columns = z.number().int().min(10).max(1000);
const rows = z.number().int().min(4).max(500);

/** Client -> server control messages. */
export const TerminalClientMessageSchema = z.discriminatedUnion('type', [
  /** Must be the first message: opens the PTY with the browser's size. */
  z.object({ type: z.literal('open'), cols: columns, rows }),
  z.object({ type: z.literal('resize'), cols: columns, rows }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

/** Server -> client control messages. */
export const TerminalServerMessageSchema = z.discriminatedUnion('type', [
  /** The shell is open; output follows as binary frames. */
  z.object({ type: z.literal('ready') }),
  /** The shell ended (the user typed `exit`, or the remote closed it). */
  z.object({
    type: z.literal('exit'),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
  /** The terminal could not be opened or was lost. Shown to the user verbatim. */
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessageSchema>;
