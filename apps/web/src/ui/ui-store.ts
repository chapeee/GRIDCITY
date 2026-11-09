import { create } from 'zustand';
import { readStoredJson, writeStoredJson } from './browser-storage';

const LITE_MODE_KEY = 'preferences:lite-mode';

/** A short message shown at the bottom of the screen. */
export interface Notice {
  id: number;
  text: string;
}

/**
 * UI-only state: what the user is looking at and their display preferences.
 * Fleet data lives in the fleet store; nothing here describes host health.
 */
interface UiStore {
  focusedHostId: string | null;
  paletteOpen: boolean;
  /** Lite mode: no post-processing, no particles. Remembered per browser. */
  liteMode: boolean;
  perfOverlayVisible: boolean;
  tuningPanelVisible: boolean;
  /** Set once the slow-frame suggestion was shown, so it never nags twice. */
  liteSuggestionShown: boolean;
  liteSuggestionVisible: boolean;
  notice: Notice | null;
  /** The browser dropped the WebGL context: the city on screen is no longer live. */
  renderingLost: boolean;

  focusHost(hostId: string | null): void;
  setPaletteOpen(open: boolean): void;
  setLiteMode(enabled: boolean): void;
  togglePerfOverlay(): void;
  toggleTuningPanel(): void;
  suggestLiteMode(): void;
  dismissLiteSuggestion(): void;
  showNotice(text: string): void;
  clearNotice(id: number): void;
  setRenderingLost(lost: boolean): void;
}

let nextNoticeId = 1;

export const useUiStore = create<UiStore>()((set, get) => ({
  focusedHostId: null,
  paletteOpen: false,
  liteMode: readStoredJson(LITE_MODE_KEY, false),
  perfOverlayVisible: import.meta.env.DEV,
  tuningPanelVisible: false,
  liteSuggestionShown: false,
  liteSuggestionVisible: false,
  notice: null,
  renderingLost: false,

  focusHost: (hostId) => set({ focusedHostId: hostId }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setLiteMode: (enabled) => {
    writeStoredJson(LITE_MODE_KEY, enabled);
    set({ liteMode: enabled, liteSuggestionVisible: false });
  },
  togglePerfOverlay: () => set((s) => ({ perfOverlayVisible: !s.perfOverlayVisible })),
  toggleTuningPanel: () => set((s) => ({ tuningPanelVisible: !s.tuningPanelVisible })),
  suggestLiteMode: () => {
    if (get().liteSuggestionShown || get().liteMode) return;
    set({ liteSuggestionShown: true, liteSuggestionVisible: true });
  },
  dismissLiteSuggestion: () => set({ liteSuggestionVisible: false }),
  showNotice: (text) => set({ notice: { id: nextNoticeId++, text } }),
  clearNotice: (id) => set((s) => (s.notice?.id === id ? { notice: null } : s)),
  setRenderingLost: (lost) => set({ renderingLost: lost }),
}));
