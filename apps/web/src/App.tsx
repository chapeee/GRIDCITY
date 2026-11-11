import { lazy, Suspense, useCallback, useEffect } from 'react';
import { connectAgentSocket } from './data/agent-store';
import { useServerLink } from './data/server-link';
import { useFleetDataSource } from './data/use-fleet-data-source';
import { useFleetStore } from './data/fleet-store';
import { AddHostDialog } from './ui/AddHostDialog';
import { AgentPanel, ApprovalCards } from './ui/AgentPanel';
import { AuditLogPanel } from './ui/AuditLogPanel';
import { CommandPalette } from './ui/CommandPalette';
import { canOpenTerminal, FocusHud } from './ui/FocusHud';
import { ResourceHud } from './ui/ResourceHud';
import { EditHostDialog } from './ui/EditHostDialog';
import { ConnectResourceDialog } from './ui/ConnectResourceDialog';
import { EditResourceDialog } from './ui/EditResourceDialog';
import { HistoryPanel } from './ui/HistoryPanel';
import { SettingsPanel } from './ui/SettingsPanel';
import {
  LiteModeSuggestion,
  NoticeToast,
  PerfOverlay,
  ShortcutHints,
  TopBar,
} from './ui/ScreenOverlays';
import { IntroOverlay } from './ui/IntroOverlay';
import { EmptyFleet, StatusBanners } from './ui/StatusBanners';
import { DiveOverlay, TerminalView } from './ui/TerminalView';
import { useAmbientDirector } from './ui/use-ambient-director';
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
    const resource = useFleetStore.getState().resources.find((r) => r.id === hostId);
    if (resource) {
      useUiStore
        .getState()
        .showNotice(
          `${resource.name} is a ${resource.engine} resource: there is no shell to open.`,
        );
      return;
    }
    const status = useFleetStore.getState().states[hostId]?.status ?? 'unknown';
    const ui = useUiStore.getState();
    if (!canOpenTerminal(status)) {
      ui.showNotice(`${hostId} is ${status}: no SSH connection to open a terminal on.`);
      return;
    }
    ui.startJackIn(hostId);
  }, []);

  useGlobalShortcuts({ navigationOrder: model.navigationOrder, onJackIn: jackIn });
  useAmbientDirector(model.navigationOrder);

  // AI approvals must reach the user even with the agent panel closed.
  const source = useServerLink((store) => store.source);
  useEffect(() => (source === 'server' ? connectAgentSocket() : undefined), [source]);

  return (
    <div className="app">
      <WorldScene model={model} />
      <TopBar />
      <StatusBanners />
      <EmptyFleet />
      <FocusHud onJackIn={jackIn} />
      <ResourceHud />
      <ShortcutHints />
      <PerfOverlay />
      <LiteModeSuggestion />
      <NoticeToast />
      <CommandPalette onJackIn={jackIn} />
      <AuditLogPanel />
      <HistoryPanel />
      <SettingsPanel />
      <EditHostDialog />
      <ConnectResourceDialog />
      <EditResourceDialog />
      <AgentPanel />
      <AddHostDialog />
      <DiveOverlay />
      <TerminalView />
      <IntroOverlay />
      <ApprovalCards />
      {DevTuningPanel && (
        <Suspense fallback={null}>
          <DevTuningPanel hidden={!tuningPanelVisible} />
        </Suspense>
      )}
    </div>
  );
}
