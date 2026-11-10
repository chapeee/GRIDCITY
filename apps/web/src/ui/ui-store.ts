import { create } from 'zustand';
import { readStoredJson, writeStoredJson } from './browser-storage';

const LITE_MODE_KEY = 'preferences:lite-mode';
const INTRO_SEEN_KEY = 'preferences:intro-seen';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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
  /** The terminal ("jack in") and where its transition is. Null when in the city. */
  terminal: TerminalSession | null;
  /** Ambient mode: the camera tours hosts that need attention (second monitor). */
  ambientMode: boolean;
  /** The entrance sequence is playing. Auto-skipped after the first visit. */
  introPlaying: boolean;
  auditLogOpen: boolean;
  addHostOpen: boolean;
  /** The AI agent panel (approvals still pop up when it is closed). */
  agentPanelOpen: boolean;
  /** History panel: undefined = closed, null = whole fleet, otherwise one host or resource. */
  historyTarget: string | null | undefined;
  settingsOpen: boolean;
  /** The host being edited (rename, district, thresholds), or null. */
  editHostId: string | null;

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
  /** Starts the dive into a host (the camera and overlay react to the phase). */
  startJackIn(hostId: string): void;
  setTerminalPhase(phase: TerminalPhase): void;
  /** Starts the reverse transition back to the city. */
  exitTerminal(): void;
  closeTerminal(): void;
  setAmbientMode(enabled: boolean): void;
  /** Focus chosen by ambient mode (does not turn ambient mode off, unlike focusHost). */
  ambientFocus(hostId: string | null): void;
  startIntro(): void;
  endIntro(): void;
  setAuditLogOpen(open: boolean): void;
  setAddHostOpen(open: boolean): void;
  setAgentPanelOpen(open: boolean): void;
  openHistory(target: string | null | undefined): void;
  setSettingsOpen(open: boolean): void;
  setEditHostId(hostId: string | null): void;
}

/**
 * diving: camera plunges into the tower; open: terminal on screen (3D paused);
 * surfacing: reverse transition back to the focused tower.
 */
export type TerminalPhase = 'diving' | 'open' | 'surfacing';

export interface TerminalSession {
  hostId: string;
  phase: TerminalPhase;
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
  terminal: null,
  ambientMode: false,
  introPlaying: !readStoredJson(INTRO_SEEN_KEY, false) && !prefersReducedMotion(),
  auditLogOpen: false,
  addHostOpen: false,
  agentPanelOpen: false,
  historyTarget: undefined,
  settingsOpen: false,
  editHostId: null,

  // Any manual navigation takes the camera back from ambient mode.
  focusHost: (hostId) => set({ focusedHostId: hostId, ambientMode: false }),
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
  startJackIn: (hostId) =>
    set({ focusedHostId: hostId, paletteOpen: false, terminal: { hostId, phase: 'diving' } }),
  setTerminalPhase: (phase) =>
    set((s) => (s.terminal ? { terminal: { ...s.terminal, phase } } : s)),
  exitTerminal: () =>
    set((s) => (s.terminal ? { terminal: { ...s.terminal, phase: 'surfacing' } } : s)),
  closeTerminal: () => set({ terminal: null }),
  setAmbientMode: (enabled) => set({ ambientMode: enabled, focusedHostId: null }),
  ambientFocus: (hostId) => set({ focusedHostId: hostId }),
  startIntro: () => set({ introPlaying: true, focusedHostId: null, ambientMode: false }),
  endIntro: () => {
    writeStoredJson(INTRO_SEEN_KEY, true);
    set({ introPlaying: false });
  },
  setAuditLogOpen: (open) => set({ auditLogOpen: open }),
  setAddHostOpen: (open) => set({ addHostOpen: open, paletteOpen: false }),
  setAgentPanelOpen: (open) => set({ agentPanelOpen: open, paletteOpen: false }),
  openHistory: (target) =>
    set(
      target === undefined
        ? { historyTarget: undefined }
        : { historyTarget: target, paletteOpen: false, settingsOpen: false },
    ),
  setSettingsOpen: (open) =>
    set(
      open
        ? { settingsOpen: true, paletteOpen: false, historyTarget: undefined }
        : { settingsOpen: false },
    ),
  setEditHostId: (hostId) => set({ editHostId: hostId, paletteOpen: false }),
}));
