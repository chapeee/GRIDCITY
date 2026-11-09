import { lazy, Suspense, useCallback, useEffect } from 'react';
import { createDemoDataSource } from './data/demo-source';
import { parseDemoOptions } from './data/demo-options';
import { useFleetStore } from './data/fleet-store';
import { CommandPalette } from './ui/CommandPalette';
import { canOpenTerminal, FocusHud } from './ui/FocusHud';
import {
  LiteModeSuggestion,
  NoticeToast,
  PerfOverlay,
  ShortcutHints,
  TopBar,
} from './ui/ScreenOverlays';
import { useGlobalShortcuts } from './ui/use-global-shortcuts';
import { useUiStore } from './ui/ui-store';
import { useCityModel } from './world/use-city-model';
import { WorldScene } from './world/WorldScene';

/**
 * Phase 1 always runs the in-browser demo fleet (with the DEMO DATA badge).
 * Phase 3 replaces this with the server's WebSocket source, which decides
 * between real and demo data.
 */
function useFleetDataSource(): void {
  useEffect(() => {
    const source = createDemoDataSource(parseDemoOptions(window.location.search), __PROJECT_NAME__);
    return source.start(useFleetStore.getState().receive);
  }, []);
}

/** Dev-only tuning sliders; the dynamic import disappears from production builds. */
const DevTuningPanel = import.meta.env.DEV ? lazy(() => import('./world/DevTuningPanel')) : null;

export function App() {
  useFleetDataSource();
  const model = useCityModel();
  const tuningPanelVisible = useUiStore((store) => store.tuningPanelVisible);

  const jackIn = useCallback((hostId: string) => {
    const status = useFleetStore.getState().states[hostId]?.status ?? 'unknown';
    useUiStore
      .getState()
      .showNotice(
        canOpenTerminal(status)
          ? `Terminal for ${hostId} arrives in Phase 4.`
          : `${hostId} is ${status}: no SSH connection to open a terminal on.`,
      );
  }, []);

  useGlobalShortcuts({ navigationOrder: model.navigationOrder, onJackIn: jackIn });

  return (
    <div className="app">
      <WorldScene model={model} />
      <TopBar />
      <FocusHud onJackIn={jackIn} />
      <ShortcutHints />
      <PerfOverlay />
      <LiteModeSuggestion />
      <NoticeToast />
      <CommandPalette onJackIn={jackIn} />
      {DevTuningPanel && (
        <Suspense fallback={null}>
          <DevTuningPanel hidden={!tuningPanelVisible} />
        </Suspense>
      )}
    </div>
  );
}
