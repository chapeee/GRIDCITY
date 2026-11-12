import { DEFAULT_RESOURCE_THRESHOLDS, isManageable, isStale, runbookMatches } from '@app/shared';
import { Command } from 'cmdk';
import { useState, type ReactNode } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { useReplayStore } from '../data/replay-store';
import { StatusDot } from './StatusDot';
import { useServerLink } from '../data/server-link';
import { rankSections } from './palette-rank';
import { useHostImport } from './use-host-import';
import { useNow } from './use-now';
import { useUiStore } from './ui-store';

interface CommandPaletteProps {
  onJackIn(hostId: string): void;
}

interface PaletteEntry {
  key: string;
  /** What the search matches; keep it short, long strings fuzzy-match unrelated searches. */
  value: string;
  keywords?: string[];
  onSelect(): void;
  children: ReactNode;
}

interface PaletteSection {
  key: string;
  heading: string;
  entries: PaletteEntry[];
}

/**
 * Cmd/Ctrl+K. Every action reachable in the 3D world is reachable here by
 * keyboard. Actions for features that do not exist yet are not listed.
 */
export function CommandPalette({ onJackIn }: CommandPaletteProps) {
  const open = useUiStore((store) => store.paletteOpen);
  const setOpen = useUiStore((store) => store.setPaletteOpen);
  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="palette"
      overlayClassName="palette-overlay"
      contentClassName="palette-content"
      // We rank ourselves (palette-rank.ts): cmdk cannot reorder groups.
      shouldFilter={false}
    >
      {/* Unmounts when closed, so the search starts empty next time. */}
      <PaletteBody onJackIn={onJackIn} close={() => setOpen(false)} />
    </Command.Dialog>
  );
}

function PaletteBody({ onJackIn, close }: CommandPaletteProps & { close(): void }) {
  const [search, setSearch] = useState('');
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
  const fromServer = useServerLink.getState().source === 'server';
  const now = useNow(1000);

  const run = (action: () => void) => () => {
    action();
    close();
  };

  const hostEntries: PaletteEntry[] = hosts.map((host) => {
    const state = states[host.id];
    const stale = state ? state.stale || isStale(state.lastSeenAt, now, thresholds) : false;
    return {
      key: host.id,
      value: `host ${host.name} ${host.district} ${host.address} ${host.tags.join(' ')}`,
      onSelect: run(() => focusHost(host.id)),
      children: (
        <>
          <StatusDot status={state?.status ?? 'unknown'} stale={stale} />
          <span className="palette-item-title">{host.name}</span>
          <span className="palette-item-meta">
            {host.district} · {stale ? 'stale' : (state?.status ?? 'unknown')}
          </span>
        </>
      ),
    };
  });

  const resourceEntries: PaletteEntry[] = resources.map((resource) => {
    const state = resourceStates[resource.id];
    const stale = state
      ? state.stale ||
        isStale(state.lastSeenAt, now, {
          pollIntervalMs: state.pollIntervalMs,
          staleAfterPolls: DEFAULT_RESOURCE_THRESHOLDS.staleAfterPolls,
        })
      : false;
    return {
      key: resource.id,
      value: `${resource.name} ${resource.engine}`,
      keywords: [resource.kind, resource.district, ...resource.tags],
      onSelect: run(() => focusHost(resource.id)),
      children: (
        <>
          <StatusDot status={state?.status ?? 'unknown'} stale={stale} />
          <span className="palette-item-title">{resource.name}</span>
          <span className="palette-item-meta">
            {resource.engine} · {stale ? 'stale' : (state?.status ?? 'unknown')}
          </span>
        </>
      ),
    };
  });

  const manageEntries: PaletteEntry[] =
    dataMode === 'real'
      ? resources
          .filter((r) => isManageable(r.kind))
          .map((resource) => ({
            key: `manage-${resource.id}`,
            // No broad keywords: they would fuzzy-match unrelated searches ("audit").
            value: `manage ${resource.name} ${resource.sourceId}`,
            onSelect: run(() =>
              useUiStore.getState().openManage({
                id: resource.sourceId,
                bucket:
                  resource.kind === 's3' && resource.id !== resource.sourceId
                    ? resource.name
                    : undefined,
              }),
            ),
            children: (
              <>
                <span className="palette-item-title">
                  Manage {resource.name}
                  {resource.kind === 's3' && resource.id !== resource.sourceId
                    ? ` · ${resource.sourceId}`
                    : ''}
                </span>
                <span className="palette-item-meta">
                  {resource.kind === 's3'
                    ? 'browse, upload, permissions'
                    : resource.kind === 'redis'
                      ? 'keys, console, activity'
                      : resource.kind === 'mongodb'
                        ? 'documents, indexes'
                        : 'tables, query, edit rows'}
                </span>
              </>
            ),
          }))
      : [];

  const districtEntries: PaletteEntry[] = districts.map((district) => {
    const members = [
      ...hosts.filter((h) => h.district === district.name).map((h) => states[h.id]),
      ...resources.filter((r) => r.district === district.name).map((r) => resourceStates[r.id]),
    ];
    const trouble = members.filter(
      (s) => s?.status === 'offline' || s?.status === 'degraded',
    ).length;
    return {
      key: district.id,
      value: `district ${district.name} ${district.provider ?? ''} ${district.region ?? ''}`,
      onSelect: run(() => useUiStore.getState().focusDistrict(district.name)),
      children: (
        <>
          <span className="palette-item-title">{district.name}</span>
          <span className="palette-item-meta">
            {members.length} building{members.length === 1 ? '' : 's'}
            {trouble > 0 ? ` · ${trouble} in trouble` : ''}
          </span>
        </>
      ),
    };
  });

  const runbookEntries: PaletteEntry[] =
    runbooks.length > 0
      ? [
          ...runbooks
            .filter((runbook) => !focusedHost || runbookMatches(runbook, focusedHost))
            .slice(0, 12)
            .map((runbook) => ({
              key: runbook.id,
              // Name only: whole descriptions fuzzy-match unrelated searches ("audit" -> "Listening ports").
              value: `run runbook ${runbook.name}`,
              onSelect: run(() =>
                useUiStore.getState().openRunbooks(focusedHost ? [focusedHost.id] : [], runbook.id),
              ),
              children: (
                <>
                  <span className="palette-item-title">{runbook.name}</span>
                  <span className="palette-item-meta">
                    {runbook.readOnly ? 'read-only' : 'changes things'}
                  </span>
                </>
              ),
            })),
          {
            key: 'fleet-exec',
            value: 'run a command on many servers fleet exec shell',
            onSelect: run(() =>
              useUiStore.getState().openRunbooks(focusedHost ? [focusedHost.id] : []),
            ),
            children: (
              <>
                <span className="palette-item-title">Run a command on servers…</span>
                <span className="palette-item-meta">pick servers by district or tag</span>
                <kbd>R</kbd>
              </>
            ),
          },
        ]
      : [];

  const focusedName = focusedResource?.name ?? focusedHost?.name ?? focusedHostId;
  const actionEntries: (PaletteEntry | false)[] = [
    {
      key: 'time-travel',
      value: 'time travel replay rewind history scrub past timeline',
      onSelect: run(() => useReplayStore.getState().open()),
      children: (
        <>
          <span className="palette-item-title">Time travel</span>
          <span className="palette-item-meta">rewind the whole city, play it back</span>
          <kbd>T</kbd>
        </>
      ),
    },
    {
      key: 'doctor',
      value: 'doctor diagnose why fix connection problem broken root cause',
      onSelect: run(() => useUiStore.getState().openDoctor(focusedHostId ?? null)),
      children: (
        <>
          <span className="palette-item-title">
            Doctor{focusedHostId ? `: diagnose ${focusedName}` : ': check everything'}
          </span>
          <span className="palette-item-meta">root causes and proven fixes</span>
          <kbd>D</kbd>
        </>
      ),
    },
    !!focusedHostId && {
      key: 'history',
      value: 'history incidents overloaded when was it down',
      onSelect: run(() => useUiStore.getState().openHistory(focusedHostId)),
      children: (
        <>
          <span className="palette-item-title">History of {focusedName}</span>
          <span className="palette-item-meta">when it was overloaded or down</span>
          <kbd>H</kbd>
        </>
      ),
    },
    !!focusedHostId &&
      !focusedResource &&
      dataMode === 'real' && {
        key: 'edit-host',
        value: 'edit rename server district tags thresholds warnings',
        onSelect: run(() => useUiStore.getState().setEditHostId(focusedHostId)),
        children: (
          <>
            <span className="palette-item-title">Edit {focusedHost?.name ?? focusedHostId}…</span>
            <span className="palette-item-meta">name, district, tags, warning thresholds</span>
            <kbd>E</kbd>
          </>
        ),
      },
    !!focusedHostId &&
      !focusedResource && {
        key: 'jack-in',
        value: 'open terminal jack in',
        onSelect: run(() => onJackIn(focusedHostId)),
        children: (
          <>
            <span className="palette-item-title">Open terminal on {focusedHostId}</span>
            <kbd>Enter</kbd>
          </>
        ),
      },
    !!focusedHostId && {
      key: 'overview',
      value: 'return to overview',
      onSelect: run(() => focusHost(null)),
      children: (
        <>
          <span className="palette-item-title">Return to overview</span>
          <kbd>Esc</kbd>
        </>
      ),
    },
    fromServer &&
      dataMode === 'real' && {
        key: 'connect-resource',
        value:
          'connect a database or bucket add postgres mysql mongodb redis sql server sqlite rds s3 spaces minio r2 http probe tcp port load balancer alb',
        onSelect: run(() => useUiStore.getState().setConnectResourceOpen(true)),
        children: (
          <>
            <span className="palette-item-title">
              Connect a database, bucket, probe or balancer…
            </span>
            <span className="palette-item-meta">
              Postgres, MySQL, Mongo, Redis, SQL Server, SQLite, RDS, S3, HTTP, TCP, ALB
            </span>
          </>
        ),
      },
    !!focusedResource &&
      dataMode === 'real' && {
        key: 'edit-resource',
        value: 'edit rename resource database bucket district tags remove',
        onSelect: run(() => useUiStore.getState().setEditResourceId(focusedResource.sourceId)),
        children: (
          <>
            <span className="palette-item-title">Edit {focusedResource.name}…</span>
            <span className="palette-item-meta">name, district, tags, remove</span>
            <kbd>E</kbd>
          </>
        ),
      },
    fromServer && {
      key: 'add-host',
      value: 'connect a server add host new ssh',
      onSelect: run(() => useUiStore.getState().setAddHostOpen(true)),
      children: (
        <>
          <span className="palette-item-title">Connect a server…</span>
          <span className="palette-item-meta">address, trust, key: no terminal needed</span>
        </>
      ),
    },
    dataMode === 'real' && {
      key: 'import-hosts',
      value: 'import hosts from ssh config',
      onSelect: run(() => void importHosts()),
      children: (
        <>
          <span className="palette-item-title">Import hosts from ~/.ssh/config</span>
          <span className="palette-item-meta">adds to hosts.yaml</span>
        </>
      ),
    },
    dataMode === 'real' && {
      key: 'agent',
      value: 'ask an ai agent codex gemini claude code chatgpt assistant voice',
      onSelect: run(() => useUiStore.getState().setAgentPanelOpen(true)),
      children: (
        <>
          <span className="palette-item-title">Ask an AI agent…</span>
          <span className="palette-item-meta">
            Codex, Gemini, Claude Code: you approve every command
          </span>
        </>
      ),
    },
    {
      key: 'ambient',
      value: 'ambient mode tour unhealthy hosts second monitor',
      onSelect: run(() => setAmbientMode(!ambientMode)),
      children: (
        <>
          <span className="palette-item-title">{ambientMode ? 'Stop' : 'Start'} ambient mode</span>
          <span className="palette-item-meta">tour hosts that need attention</span>
          <kbd>A</kbd>
        </>
      ),
    },
    {
      key: 'fleet-history',
      value: 'fleet history incidents overloaded down last 7 days',
      onSelect: run(() => useUiStore.getState().openHistory(null)),
      children: (
        <>
          <span className="palette-item-title">Fleet history</span>
          <span className="palette-item-meta">every overload and outage, kept for days</span>
          <kbd>H</kbd>
        </>
      ),
    },
    {
      key: 'settings',
      value: 'settings preferences history retention thresholds warnings',
      onSelect: run(() => useUiStore.getState().setSettingsOpen(true)),
      children: (
        <>
          <span className="palette-item-title">Settings…</span>
          <span className="palette-item-meta">history retention, warning thresholds</span>
        </>
      ),
    },
    {
      key: 'audit-log',
      value: 'open audit log',
      onSelect: run(() => setAuditLogOpen(true)),
      children: (
        <>
          <span className="palette-item-title">Open audit log</span>
          <span className="palette-item-meta">connections, key refusals, terminals</span>
        </>
      ),
    },
    {
      key: 'intro',
      value: 'replay intro',
      onSelect: run(startIntro),
      children: <span className="palette-item-title">Replay intro</span>,
    },
    {
      key: 'lite-mode',
      value: 'toggle lite mode',
      onSelect: run(() => setLiteMode(!liteMode)),
      children: (
        <>
          <span className="palette-item-title">{liteMode ? 'Disable' : 'Enable'} lite mode</span>
          <span className="palette-item-meta">no bloom, no particles</span>
        </>
      ),
    },
    {
      key: 'perf-overlay',
      value: 'toggle performance overlay',
      onSelect: run(togglePerfOverlay),
      children: <span className="palette-item-title">Toggle performance overlay</span>,
    },
    import.meta.env.DEV && {
      key: 'tuning',
      value: 'toggle tuning panel',
      onSelect: run(toggleTuningPanel),
      children: (
        <>
          <span className="palette-item-title">Toggle tuning panel</span>
          <span className="palette-item-meta">dev only</span>
        </>
      ),
    },
  ];

  const sections: PaletteSection[] = [
    { key: 'hosts', heading: 'Hosts', entries: hostEntries },
    { key: 'resources', heading: 'Databases & storage', entries: resourceEntries },
    { key: 'manage', heading: 'Manage', entries: manageEntries },
    { key: 'districts', heading: 'Districts', entries: districtEntries },
    {
      key: 'runbooks',
      heading: focusedHost ? `Run on ${focusedHost.name}` : 'Runbooks',
      entries: runbookEntries,
    },
    {
      key: 'actions',
      heading: 'Actions',
      entries: actionEntries.filter((entry): entry is PaletteEntry => !!entry),
    },
  ].filter((section) => section.entries.length > 0);

  return (
    <>
      <Command.Input
        placeholder="Search hosts and actions…"
        className="palette-input"
        value={search}
        onValueChange={setSearch}
      />
      <Command.List className="palette-list">
        <Command.Empty className="palette-empty">No matching hosts or actions.</Command.Empty>
        {rankSections(sections, search).map((section) => (
          <Command.Group key={section.key} heading={section.heading}>
            {section.entries.map((entry) => (
              <Command.Item
                key={entry.key}
                value={entry.value}
                keywords={entry.keywords}
                onSelect={entry.onSelect}
              >
                {entry.children}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </>
  );
}
