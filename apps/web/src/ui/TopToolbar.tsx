import { isMaintenance, type HostStatus } from '@app/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { alertsApi } from '../data/alerts-api';
import { useFleetStore } from '../data/fleet-store';
import { useReplayStore } from '../data/replay-store';
import { useServerLink } from '../data/server-link';
import { useUiStore } from './ui-store';

/** Stroke icons, 16 px, drawn in currentColor. */
const ICONS: Record<string, ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  doctor: <path d="M2 8h3l1.5-3 3 6L11 8h3" />,
  rewind: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2 2.5v3h3M8 5v3l2 1.5" />
    </>
  ),
  history: <path d="M2 13h12M4 11V7M7 11V4M10 11V8M13 11V6" />,
  runbook: <path d="M3 4l3 3-3 3M8 11h5" />,
  audit: <path d="M4 3h8v10H4zM6 6h4M6 8.5h4M6 11h2" />,
  agent: <path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" />,
  calendar: (
    <>
      <path d="M2.5 4h11v9.5h-11z" />
      <path d="M2.5 7h11M5.5 2.5v3M10.5 2.5v3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 14 14" />
    </>
  ),
  shield: <path d="M8 1.8 13 3.7v4c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5v-4z" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" />
    </>
  ),
  bell: (
    <>
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z" />
      <path d="M6.5 14h3" />
    </>
  ),
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="toolbar-icon">
      {ICONS[name]}
    </svg>
  );
}

interface ToolButtonProps {
  icon: keyof typeof ICONS;
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  className?: string;
  children?: ReactNode;
}

function ToolButton({
  icon,
  label,
  shortcut,
  active,
  onClick,
  className,
  children,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`toolbar-button${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active}
      data-tip={shortcut ? `${label} · ${shortcut}` : label}
      onClick={onClick}
    >
      <Icon name={icon} />
      {children}
    </button>
  );
}

/**
 * Top right: every panel one click away (the keyboard shortcuts still work),
 * plus whether alerts reach anyone while the app is closed.
 */
export function TopToolbar() {
  const live = useServerLink((link) => link.source === 'server');
  const ui = useUiStore(
    useShallow((store) => ({
      doctor: store.doctorTarget !== undefined,
      history: store.historyTarget !== undefined,
      runbooks: store.runbookPanel !== null,
      audit: store.auditLogOpen,
      agent: store.agentPanelOpen,
      settings: store.settingsOpen,
      security: store.securityOpen,
      upcoming: store.upcomingOpen,
      logs: store.logsOpen,
      connect: store.connectResourceOpen,
      terminal: store.terminal !== null,
    })),
  );
  const replay = useReplayStore((store) => store.active);
  const alerts = useAlertReach(live, ui.settings);
  const serious = useFleetStore(
    (store) =>
      store.threats.filter(
        (f) => !isMaintenance(f) && (f.severity === 'high' || f.severity === 'critical'),
      ).length,
  );
  const watched = useFleetStore((store) => store.threats.filter((f) => !isMaintenance(f)).length);
  const upkeep = useFleetStore((store) => store.threats.filter((f) => isMaintenance(f)).length);

  if (ui.terminal) return null;
  /** The side panels share the right edge: opening one from here closes the others. */
  const store = () => {
    const state = useUiStore.getState();
    state.openDoctor(undefined);
    state.openHistory(undefined);
    state.closeRunbooks();
    state.setAuditLogOpen(false);
    state.setAgentPanelOpen(false);
    state.setSettingsOpen(false);
    state.setSecurityOpen(false);
    state.setUpcomingOpen(false);
    state.setLogsOpen(false);
    return useUiStore.getState();
  };
  const close = () => useUiStore.getState();

  return (
    <nav className="top-toolbar" aria-label="Tools">
      {live && (
        <ToolButton
          icon="plus"
          label="Connect a server, database, bucket or probe"
          active={ui.connect}
          className="is-primary"
          onClick={() => close().setConnectResourceOpen(!ui.connect)}
        >
          <span className="toolbar-label">Connect</span>
        </ToolButton>
      )}
      <span className="toolbar-group">
        <ToolButton
          icon="shield"
          label={
            serious > 0
              ? `Security: ${serious} serious finding${serious === 1 ? '' : 's'}`
              : watched > 0
                ? `Security: ${watched} open finding${watched === 1 ? '' : 's'}`
                : 'Security'
          }
          shortcut="S"
          active={ui.security}
          className={serious > 0 ? 'is-alarm' : watched > 0 ? 'is-watch' : undefined}
          onClick={() =>
            ui.security ? close().setSecurityOpen(false) : store().setSecurityOpen(true)
          }
        >
          {watched > 0 && <span className="toolbar-count">{serious > 0 ? serious : watched}</span>}
        </ToolButton>
        <ToolButton
          icon="calendar"
          label={
            upkeep > 0
              ? `Upcoming: ${upkeep} need${upkeep === 1 ? 's' : ''} attention`
              : 'Upcoming: expiry dates, disks, backups'
          }
          shortcut="U"
          active={ui.upcoming}
          className={upkeep > 0 ? 'is-watch' : undefined}
          onClick={() =>
            ui.upcoming ? close().setUpcomingOpen(false) : store().setUpcomingOpen(true)
          }
        >
          {upkeep > 0 && <span className="toolbar-count">{upkeep}</span>}
        </ToolButton>
        <ToolButton
          icon="search"
          label="Search logs on every server"
          shortcut="L"
          active={ui.logs}
          onClick={() => (ui.logs ? close().setLogsOpen(false) : store().setLogsOpen(true))}
        />
        <ToolButton
          icon="doctor"
          label="Doctor"
          shortcut="D"
          active={ui.doctor}
          onClick={() => (ui.doctor ? close().openDoctor(undefined) : store().openDoctor(null))}
        />
        <ToolButton
          icon="rewind"
          label="Time travel"
          shortcut="T"
          active={replay}
          onClick={() =>
            replay ? useReplayStore.getState().close() : useReplayStore.getState().open()
          }
        />
        <ToolButton
          icon="history"
          label="History"
          active={ui.history}
          onClick={() => (ui.history ? close().openHistory(undefined) : store().openHistory(null))}
        />
        <ToolButton
          icon="runbook"
          label="Runbooks and fleet commands"
          shortcut="R"
          active={ui.runbooks}
          onClick={() => (ui.runbooks ? close().closeRunbooks() : store().openRunbooks())}
        />
        <ToolButton
          icon="audit"
          label="Audit log"
          active={ui.audit}
          onClick={() =>
            ui.audit ? close().setAuditLogOpen(false) : store().setAuditLogOpen(true)
          }
        />
        <ToolButton
          icon="agent"
          label="AI agent"
          active={ui.agent}
          onClick={() =>
            ui.agent ? close().setAgentPanelOpen(false) : store().setAgentPanelOpen(true)
          }
        />
      </span>
      <span className="toolbar-group">
        {live && (
          <ToolButton
            icon="bell"
            label={alerts.label}
            className={alerts.reach > 0 ? 'is-armed' : 'is-unarmed'}
            onClick={() => store().setSettingsOpen(true)}
          />
        )}
        <ToolButton
          icon="settings"
          label="Settings"
          active={ui.settings}
          onClick={() =>
            ui.settings ? close().setSettingsOpen(false) : store().setSettingsOpen(true)
          }
        />
      </span>
    </nav>
  );
}

/** How many channels and browsers hear about trouble (refreshed when Settings closes). */
function useAlertReach(live: boolean, settingsOpen: boolean) {
  const [reach, setReach] = useState<{ channels: number; browsers: number } | null>(null);
  useEffect(() => {
    if (!live || settingsOpen) return;
    let cancelled = false;
    alertsApi.load().then(
      (view) => {
        if (cancelled) return;
        setReach({
          channels: view.channels.filter((channel) => channel.enabled).length,
          browsers: view.push.devices.length,
        });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [live, settingsOpen]);
  const total = (reach?.channels ?? 0) + (reach?.browsers ?? 0);
  const parts = [
    reach?.channels ? `${reach.channels} channel${reach.channels === 1 ? '' : 's'}` : '',
    reach?.browsers ? `${reach.browsers} browser${reach.browsers === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return {
    reach: total,
    label:
      reach === null
        ? 'Alerts'
        : total > 0
          ? `Alerts on: ${parts.join(', ')}`
          : 'Alerts off: set them up',
  };
}

const ORDER: HostStatus[] = ['offline', 'degraded', 'online', 'unknown'];

/** "21 online · 1 degraded · 2 offline" next to the name; click to see what is wrong. */
export function FleetPulse() {
  const counts = useFleetStore(
    useShallow((store) => {
      const tally: Record<HostStatus, number> = { online: 0, degraded: 0, offline: 0, unknown: 0 };
      for (const state of Object.values(store.states)) tally[state.status] += 1;
      for (const state of Object.values(store.resourceStates)) tally[state.status] += 1;
      return tally;
    }),
  );
  const total = ORDER.reduce((sum, status) => sum + counts[status], 0);
  if (total === 0) return null;
  const trouble = counts.offline + counts.degraded;
  const label = ORDER.filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(', ');
  return (
    <button
      type="button"
      className={`fleet-pulse${trouble > 0 ? ' has-trouble' : ''}`}
      aria-label={`${label}. ${trouble > 0 ? 'Open the Doctor.' : 'Everything is healthy.'}`}
      onClick={() => useUiStore.getState().openDoctor(null)}
    >
      {ORDER.filter((status) => counts[status] > 0).map((status) => (
        <span key={status} className={`fleet-pulse-item is-${status}`}>
          <i aria-hidden="true" />
          {counts[status]}
          <span className="fleet-pulse-word"> {status}</span>
        </span>
      ))}
    </button>
  );
}
