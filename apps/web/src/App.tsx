import { lazy, Suspense, useCallback } from 'react';
import { useFleetDataSource } from './data/use-fleet-data-source';
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
import { EmptyFleet, StatusBanners } from './ui/StatusBanners';
import { DiveOverlay, TerminalView } from './ui/TerminalView';
import { useGlobalShortcuts } from './ui/use-global-shortcuts';
import { useUiStore } from './ui/ui-store';
import { useCityModel } from './world/use-city-model';
import { WorldScene } from './world/WorldScene';

/** Dev-only tuning sliders; the dynamic import disappears from production builds. */
const DevTuningPanel = import.meta.env.DEV ? lazy(() => import('./world/DevTuningPanel')) : null;

export function App() {
  useFleetDataSource();
  const model = useCityModel();
  const tuningPanelVisible = useUiStore((store) => store.tuningPanelVisible);

  const jackIn = useCallback((hostId: string) => {
    const status = useFleetStore.getState().states[hostId]?.status ?? 'unknown';
    const ui = useUiStore.getState();
    if (!canOpenTerminal(status)) {
      ui.showNotice(`${hostId} is ${status}: no SSH connection to open a terminal on.`);
      return;
    }
    ui.startJackIn(hostId);
  }, []);

  useGlobalShortcuts({ navigationOrder: model.navigationOrder, onJackIn: jackIn });

  return (
    <div className="app">
      <WorldScene model={model} />
      <TopBar />
      <StatusBanners />
      <EmptyFleet />
      <FocusHud onJackIn={jackIn} />
      <ShortcutHints />
      <PerfOverlay />
      <LiteModeSuggestion />
      <NoticeToast />
      <CommandPalette onJackIn={jackIn} />
      <DiveOverlay />
      <TerminalView />
      {DevTuningPanel && (
        <Suspense fallback={null}>
          <DevTuningPanel hidden={!tuningPanelVisible} />
        </Suspense>
      )}
    </div>
  );
}
