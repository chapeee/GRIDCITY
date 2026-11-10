import { isStale } from '@app/shared';
import { Command } from 'cmdk';
import { useFleetStore } from '../data/fleet-store';
import { StatusDot } from './StatusDot';
import { useServerLink } from '../data/server-link';
import { useHostImport } from './use-host-import';
import { useNow } from './use-now';
import { useUiStore } from './ui-store';

interface CommandPaletteProps {
  onJackIn(hostId: string): void;
}

/**
 * Cmd/Ctrl+K. Every action reachable in the 3D world is reachable here by
 * keyboard. Actions for features that do not exist yet are not listed.
 */
export function CommandPalette({ onJackIn }: CommandPaletteProps) {
  const open = useUiStore((store) => store.paletteOpen);
  const setOpen = useUiStore((store) => store.setPaletteOpen);
  const focusedHostId = useUiStore((store) => store.focusedHostId);
  const liteMode = useUiStore((store) => store.liteMode);
  const ambientMode = useUiStore((store) => store.ambientMode);
  const {
    focusHost,
    setLiteMode,
    togglePerfOverlay,
    toggleTuningPanel,
    setAmbientMode,
    setAuditLogOpen,
    startIntro,
  } = useUiStore.getState();
  const hosts = useFleetStore((store) => store.hosts);
  const dataMode = useFleetStore((store) => store.dataMode);
  const { importHosts } = useHostImport();
  const states = useFleetStore((store) => store.states);
  const thresholds = useFleetStore((store) => store.thresholds);
  const now = useNow(1000);

  const run = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="palette"
      overlayClassName="palette-overlay"
      contentClassName="palette-content"
    >
      <Command.Input placeholder="Search hosts and actions…" className="palette-input" />
      <Command.List className="palette-list">
        <Command.Empty className="palette-empty">No matching hosts or actions.</Command.Empty>

        <Command.Group heading="Hosts">
          {hosts.map((host) => {
            const state = states[host.id];
            const stale = state ? state.stale || isStale(state.lastSeenAt, now, thresholds) : false;
            return (
              <Command.Item
                key={host.id}
                value={`host ${host.name} ${host.district} ${host.address} ${host.tags.join(' ')}`}
                onSelect={() => run(() => focusHost(host.id))}
              >
                <StatusDot status={state?.status ?? 'unknown'} stale={stale} />
                <span className="palette-item-title">{host.name}</span>
                <span className="palette-item-meta">
                  {host.district} · {stale ? 'stale' : (state?.status ?? 'unknown')}
                </span>
              </Command.Item>
            );
          })}
        </Command.Group>

        <Command.Group heading="Actions">
          {focusedHostId && (
            <>
              <Command.Item
                value="open terminal jack in"
                onSelect={() => run(() => onJackIn(focusedHostId))}
              >
                <span className="palette-item-title">Open terminal on {focusedHostId}</span>
                <kbd>Enter</kbd>
              </Command.Item>
              <Command.Item value="return to overview" onSelect={() => run(() => focusHost(null))}>
                <span className="palette-item-title">Return to overview</span>
                <kbd>Esc</kbd>
              </Command.Item>
            </>
          )}
          {useServerLink.getState().source === 'server' && (
            <Command.Item
              value="connect a server add host new ssh"
              onSelect={() => run(() => useUiStore.getState().setAddHostOpen(true))}
            >
              <span className="palette-item-title">Connect a server…</span>
              <span className="palette-item-meta">address, trust, key: no terminal needed</span>
            </Command.Item>
          )}
          {dataMode === 'real' && (
            <Command.Item
              value="import hosts from ssh config"
              onSelect={() => run(() => void importHosts())}
            >
              <span className="palette-item-title">Import hosts from ~/.ssh/config</span>
              <span className="palette-item-meta">adds to hosts.yaml</span>
            </Command.Item>
          )}
          {dataMode === 'real' && (
            <Command.Item
              value="ask an ai agent codex gemini claude code chatgpt assistant voice"
              onSelect={() => run(() => useUiStore.getState().setAgentPanelOpen(true))}
            >
              <span className="palette-item-title">Ask an AI agent…</span>
              <span className="palette-item-meta">
                Codex, Gemini, Claude Code: you approve every command
              </span>
            </Command.Item>
          )}
          <Command.Item
            value="ambient mode tour unhealthy hosts second monitor"
            onSelect={() => run(() => setAmbientMode(!ambientMode))}
          >
            <span className="palette-item-title">
              {ambientMode ? 'Stop' : 'Start'} ambient mode
            </span>
            <span className="palette-item-meta">tour hosts that need attention</span>
            <kbd>A</kbd>
          </Command.Item>
          <Command.Item
            value="open audit log history"
            onSelect={() => run(() => setAuditLogOpen(true))}
          >
            <span className="palette-item-title">Open audit log</span>
            <span className="palette-item-meta">connections, key refusals, terminals</span>
          </Command.Item>
          <Command.Item value="replay intro" onSelect={() => run(startIntro)}>
            <span className="palette-item-title">Replay intro</span>
          </Command.Item>
          <Command.Item value="toggle lite mode" onSelect={() => run(() => setLiteMode(!liteMode))}>
            <span className="palette-item-title">{liteMode ? 'Disable' : 'Enable'} lite mode</span>
            <span className="palette-item-meta">no bloom, no particles</span>
          </Command.Item>
          <Command.Item value="toggle performance overlay" onSelect={() => run(togglePerfOverlay)}>
            <span className="palette-item-title">Toggle performance overlay</span>
          </Command.Item>
          {import.meta.env.DEV && (
            <Command.Item value="toggle tuning panel" onSelect={() => run(toggleTuningPanel)}>
              <span className="palette-item-title">Toggle tuning panel</span>
              <span className="palette-item-meta">dev only</span>
            </Command.Item>
          )}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
