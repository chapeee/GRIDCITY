import { useEffect } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { AMBIENT_DWELL_MS, hostsNeedingAttention, nextAmbientTarget } from '../world/ambient-tour';
import { useUiStore } from './ui-store';

/**
 * Drives ambient mode: every dwell period, focus the next host that needs
 * attention (offline, degraded, stale), or return to the slowly orbiting
 * overview when everything is healthy. Re-evaluated on every stop, so a
 * recovered host simply drops out of the tour.
 */
export function useAmbientDirector(navigationOrder: readonly string[]): void {
  const ambientMode = useUiStore((store) => store.ambientMode);

  useEffect(() => {
    if (!ambientMode) return;
    const advance = () => {
      const { states, thresholds } = useFleetStore.getState();
      const ui = useUiStore.getState();
      if (ui.terminal) return;
      const candidates = hostsNeedingAttention(navigationOrder, states, Date.now(), thresholds);
      ui.ambientFocus(nextAmbientTarget(candidates, ui.focusedHostId));
    };
    advance();
    const timer = setInterval(advance, AMBIENT_DWELL_MS);
    return () => clearInterval(timer);
  }, [ambientMode, navigationOrder]);
}
