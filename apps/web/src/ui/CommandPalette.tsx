import { DEFAULT_RESOURCE_THRESHOLDS, isStale, runbookMatches } from '@app/shared';
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
  const resources = useFleetStore((store) => store.resources);
  const resourceStates = useFleetStore((store) => store.resourceStates);
  const focusedResource = resources.find((resource) => resource.id === focusedHostId);
  const thresholds = useFleetStore((store) => store.thresholds);
  const districts = useFleetStore((store) => store.districts);
  const runbooks = useFleetStore((store) => store.runbooks);
  const focusedHost = hosts.find((h) => h.id === focusedHostId);
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

        {resources.length > 0 && (
          <Command.Group heading="Databases & storage">
            {resources.map((resource) => {
              const state = resourceStates[resource.id];
              const stale = state
                ? state.stale ||
                  isStale(state.lastSeenAt, now, {
                    pollIntervalMs: state.pollIntervalMs,
                    staleAfterPolls: DEFAULT_RESOURCE_THRESHOLDS.staleAfterPolls,
                  })
                : false;
              return (
                <Command.Item
                  key={resource.id}
                  // Short value: long strings fuzzy-match unrelated searches ("settings").
                  value={`${resource.name} ${resource.engine}`}
                  keywords={[resource.kind, resource.district, ...resource.tags]}
                  onSelect={() => run(() => focusHost(resource.id))}
                >
                  <StatusDot status={state?.status ?? 'unknown'} stale={stale} />
                  <span className="palette-item-title">{resource.name}</span>
                  <span className="palette-item-meta">
                    {resource.engine} · {stale ? 'stale' : (state?.status ?? 'unknown')}
                  </span>
                </Command.Item>
              );
            })}
          </Command.Group>
        )}

        {districts.length > 0 && (
          <Command.Group heading="Districts">
            {districts.map((district) => {
              const members = [
                ...hosts.filter((h) => h.district === district.name).map((h) => states[h.id]),
                ...resources
                  .filter((r) => r.district === district.name)
                  .map((r) => resourceStates[r.id]),
              ];
              const trouble = members.filter(
                (s) => s?.status === 'offline' || s?.status === 'degraded',
              ).length;
              return (
                <Command.Item
                  key={district.id}
                  value={`district ${district.name} ${district.provider ?? ''} ${district.region ?? ''}`}
                  onSelect={() => run(() => useUiStore.getState().focusDistrict(district.name))}
                >
                  <span className="palette-item-title">{district.name}</span>
                  <span className="palette-item-meta">
                    {members.length} building{members.length === 1 ? '' : 's'}
                    {trouble > 0 ? ` · ${trouble} in trouble` : ''}
                  </span>
                </Command.Item>
              );
            })}
          </Command.Group>
        )}

        {runbooks.length > 0 && (
          <Command.Group heading={focusedHost ? `Run on ${focusedHost.name}` : 'Runbooks'}>
            {runbooks
              .filter((runbook) => !focusedHost || runbookMatches(runbook, focusedHost))
              .slice(0, 12)
              .map((runbook) => (
                <Command.Item
                  key={runbook.id}
                  value={`run runbook ${runbook.name} ${runbook.description ?? ''}`}
                  onSelect={() =>
                    run(() =>
                      useUiStore
                        .getState()
                        .openRunbooks(focusedHost ? [focusedHost.id] : [], runbook.id),
                    )
                  }
                >
                  <span className="palette-item-title">{runbook.name}</span>
                  <span className="palette-item-meta">
                    {runbook.readOnly ? 'read-only' : 'changes things'}
                  </span>
                </Command.Item>
              ))}
            <Command.Item
              value="run a command on many servers fleet exec shell"
              onSelect={() =>
                run(() => useUiStore.getState().openRunbooks(focusedHost ? [focusedHost.id] : []))
              }
            >
              <span className="palette-item-title">Run a command on servers…</span>
              <span className="palette-item-meta">pick servers by district or tag</span>
              <kbd>R</kbd>
            </Command.Item>
          </Command.Group>
        )}

        <Command.Group heading="Actions">
          {focusedHostId && (
            <Command.Item
              value="history incidents overloaded when was it down"
              onSelect={() => run(() => useUiStore.getState().openHistory(focusedHostId))}
            >
              <span className="palette-item-title">
                History of{' '}
                {focusedResource?.name ??
                  hosts.find((h) => h.id === focusedHostId)?.name ??
                  focusedHostId}
              </span>
              <span className="palette-item-meta">when it was overloaded or down</span>
              <kbd>H</kbd>
            </Command.Item>
          )}
          {focusedHostId && !focusedResource && dataMode === 'real' && (
            <Command.Item
              value="edit rename server district tags thresholds warnings"
              onSelect={() => run(() => useUiStore.getState().setEditHostId(focusedHostId))}
            >
              <span className="palette-item-title">
                Edit {hosts.find((h) => h.id === focusedHostId)?.name ?? focusedHostId}…
              </span>
              <span className="palette-item-meta">name, district, tags, warning thresholds</span>
              <kbd>E</kbd>
            </Command.Item>
          )}
          {focusedResource && (
            <Command.Item value="return to overview" onSelect={() => run(() => focusHost(null))}>
              <span className="palette-item-title">Return to overview</span>
              <kbd>Esc</kbd>
            </Command.Item>
          )}
          {focusedHostId && !focusedResource && (
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
          {useServerLink.getState().source === 'server' && dataMode === 'real' && (
            <Command.Item
              value="connect a database or bucket add postgres mysql mongodb redis sql server sqlite rds s3 spaces minio r2 http probe tcp port load balancer alb"
              onSelect={() => run(() => useUiStore.getState().setConnectResourceOpen(true))}
            >
              <span className="palette-item-title">
                Connect a database, bucket, probe or balancer…
              </span>
              <span className="palette-item-meta">
                Postgres, MySQL, Mongo, Redis, SQL Server, SQLite, RDS, S3, HTTP, TCP, ALB
              </span>
            </Command.Item>
          )}
          {focusedResource && dataMode === 'real' && (
            <Command.Item
              value="edit rename resource database bucket district tags remove"
              onSelect={() =>
                run(() => useUiStore.getState().setEditResourceId(focusedResource.sourceId))
              }
            >
              <span className="palette-item-title">Edit {focusedResource.name}…</span>
              <span className="palette-item-meta">name, district, tags, remove</span>
              <kbd>E</kbd>
            </Command.Item>
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
            value="fleet history incidents overloaded down last 7 days"
            onSelect={() => run(() => useUiStore.getState().openHistory(null))}
          >
            <span className="palette-item-title">Fleet history</span>
            <span className="palette-item-meta">every overload and outage, kept for days</span>
            <kbd>H</kbd>
          </Command.Item>
          <Command.Item
            value="settings preferences history retention thresholds warnings"
            onSelect={() => run(() => useUiStore.getState().setSettingsOpen(true))}
          >
            <span className="palette-item-title">Settings…</span>
            <span className="palette-item-meta">history retention, warning thresholds</span>
          </Command.Item>
          <Command.Item value="open audit log" onSelect={() => run(() => setAuditLogOpen(true))}>
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
