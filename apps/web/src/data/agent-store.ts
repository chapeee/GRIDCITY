import { AgentServerMessageSchema, type AgentClientMessage, type AgentState } from '@app/shared';
import { create } from 'zustand';
import { checkSession } from './websocket-source';

interface AgentStore {
  /** Null until the server sent its first state (or in demo mode). */
  state: AgentState | null;
  connected: boolean;
  send(message: AgentClientMessage): void;
}

let socket: WebSocket | null = null;

export const useAgentStore = create<AgentStore>()(() => ({
  state: null,
  connected: false,
  send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  },
}));

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * Keeps the `/ws/agent` socket open (approvals, the agent panel, what AI is
 * running). Approvals must reach the user even when the panel is closed, so
 * this runs for the whole session. Returns a function that closes it.
 */
export function connectAgentSocket(location: Location = window.location): () => void {
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (stopped) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = new WebSocket(`${protocol}//${location.host}/ws/agent`);
    socket = current;
    let opened = false;
    current.addEventListener('open', () => {
      opened = true;
      attempt = 0;
      useAgentStore.setState({ connected: true });
    });
    current.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = AgentServerMessageSchema.safeParse(raw);
      if (parsed.success) useAgentStore.setState({ state: parsed.data.state });
    });
    current.addEventListener('close', async () => {
      if (socket === current) socket = null;
      useAgentStore.setState({ connected: false });
      if (stopped) return;
      // A refused upgrade with a dead session never succeeds: stop, like the state socket
      // (its "Session expired" banner tells the user to open the new link).
      if (!opened && !(await checkSession())) return;
      if (stopped) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    });
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
    socket = null;
    useAgentStore.setState({ connected: false, state: null });
  };
}
