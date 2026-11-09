import { create } from 'zustand';

/**
 * State of the browser's link to the local server.
 * - connecting:   first attempt
 * - open:         receiving live data
 * - reconnecting: the link dropped; data on screen freezes on its own as it goes stale
 * - unauthorized: the session token is missing or no longer valid (server restarted)
 */
export type ServerLinkState = 'connecting' | 'open' | 'reconnecting' | 'unauthorized';

interface ServerLinkStore {
  state: ServerLinkState;
  /** Which source feeds the city: the local server, or the in-browser demo (`?source=demo`). */
  source: 'server' | 'browser-demo';
  setState(state: ServerLinkState): void;
  setSource(source: 'server' | 'browser-demo'): void;
}

export const useServerLink = create<ServerLinkStore>()((set) => ({
  state: 'connecting',
  source: 'server',
  setState: (state) => set({ state }),
  setSource: (source) => set({ source }),
}));
