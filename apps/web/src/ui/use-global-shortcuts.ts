import { useEffect } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { useUiStore } from './ui-store';

interface ShortcutOptions {
  /** Host ids in navigation order, for Tab / Shift+Tab. */
  navigationOrder: readonly string[];
  onJackIn(hostId: string): void;
}

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * Global keyboard map. The 3D world is a map, never a gate: everything
 * reachable by pointer is reachable here.
 *
 * Ctrl/Cmd+K  palette · Tab/Shift+Tab  next/previous host · Esc  overview
 * Enter       jack in to the focused host · A  ambient mode · `  performance overlay
 * (all of these are off while the terminal is open)
 */
export function useGlobalShortcuts({ navigationOrder, onJackIn }: ShortcutOptions): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const ui = useUiStore.getState();

      // Inside the terminal every key belongs to the shell (it handles its own exit chord);
      // during the intro the first key only skips it.
      // The add-host form handles its own keys.
      if (ui.terminal || ui.introPlaying || ui.addHostOpen) return;
      // The edit dialog is a form: only Esc (to close it) is ours.
      if (ui.editHostId) {
        if (event.key === 'Escape') ui.setEditHostId(null);
        return;
      }
      if (ui.connectResourceOpen || ui.editResourceId) {
        if (event.key === 'Escape') {
          ui.setConnectResourceOpen(false);
          ui.setEditResourceId(null);
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }

      // The palette handles its own keys (including Esc to close).
      if (ui.paletteOpen || isTypingTarget(event.target)) return;

      switch (event.key) {
        case 'Escape':
          // Innermost first: panels, then ambient mode, then focus.
          if (ui.auditLogOpen) ui.setAuditLogOpen(false);
          else if (ui.historyTarget !== undefined) ui.openHistory(undefined);
          else if (ui.settingsOpen) ui.setSettingsOpen(false);
          else if (ui.agentPanelOpen) ui.setAgentPanelOpen(false);
          else if (ui.ambientMode) ui.setAmbientMode(false);
          else if (ui.focusedHostId) ui.focusHost(null);
          break;
        case 'a':
        case 'A':
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          ui.setAmbientMode(!ui.ambientMode);
          break;
        case 'Tab': {
          if (navigationOrder.length === 0) return;
          event.preventDefault();
          const current = ui.focusedHostId ? navigationOrder.indexOf(ui.focusedHostId) : -1;
          const step = event.shiftKey ? -1 : 1;
          const next = (current + step + navigationOrder.length) % navigationOrder.length;
          ui.focusHost(navigationOrder[next] ?? null);
          break;
        }
        case 'Enter':
          // Buttons inside the HUD handle Enter themselves.
          if (ui.focusedHostId && !(event.target instanceof HTMLButtonElement)) {
            onJackIn(ui.focusedHostId);
          }
          break;
        case 'h':
        case 'H':
          // History of the focused building, or every incident in the fleet.
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          ui.openHistory(ui.historyTarget !== undefined ? undefined : ui.focusedHostId);
          break;
        case 'e':
        case 'E': {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const { hosts, dataMode } = useFleetStore.getState();
          if (dataMode !== 'real' || !ui.focusedHostId) break;
          if (hosts.some((h) => h.id === ui.focusedHostId)) {
            ui.setEditHostId(ui.focusedHostId);
          } else {
            const resource = useFleetStore
              .getState()
              .resources.find((r) => r.id === ui.focusedHostId);
            if (resource) ui.setEditResourceId(resource.sourceId);
          }
          break;
        }
        case '`':
          ui.togglePerfOverlay();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigationOrder, onJackIn]);
}
