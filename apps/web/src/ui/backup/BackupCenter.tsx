import type { BackupDashboard, SourceConfig } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import {
  backupApi,
  connectBackupEvents,
  useBackupLive,
  type BackupOptions,
} from '../../data/backup-api';
import { useServerLink } from '../../data/server-link';
import { useUiStore, type BackupTab } from '../ui-store';
import './backup.css';
import { DestinationsTab } from './DestinationsTab';
import { HistoryTab, RunDetails } from './HistoryTab';
import { JobsTab } from './JobsTab';
import { RestoreTab } from './RestoreTab';
import {
  Empty,
  formatBytes,
  formatDate,
  formatWhen,
  OperationCard,
  StatusBadge,
  useLoad,
} from './shared';

const TABS: { id: BackupTab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'discover', label: 'Discover' },
  { id: 'jobs', label: 'Backup jobs' },
  { id: 'history', label: 'History' },
  { id: 'destinations', label: 'Storage' },
  { id: 'restore', label: 'Restore' },
  { id: 'notifications', label: 'Notifications' },
];

/**
 * Backup & Restore (v1.2): a full-screen workspace like Manage. Uses the
 * servers, databases and buckets already connected; progress arrives live
 * over /api/backup/events.
 */
export function BackupCenter() {
  const tab = useUiStore((s) => s.backupTab);
  return <AnimatePresence>{tab && <BackupWorkspace tab={tab} />}</AnimatePresence>;
}

function BackupWorkspace({ tab }: { tab: BackupTab }) {
  const live = useServerLink((link) => link.source === 'server');
  const [options, setOptions] = useState<BackupOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsTick, setOptionsTick] = useState(0);
  const [draft, setDraft] = useState<Partial<SourceConfig> | null>(null);
  const [restoreRun, setRestoreRun] = useState<string | null>(null);
  const unread = useBackupLive((s) => s.unread);
  const connected = useBackupLive((s) => s.connected);
  const lastNotification = useBackupLive((s) => s.lastNotification);
  const go = (next: BackupTab) => useUiStore.getState().openBackups(next);

  useEffect(() => (live ? connectBackupEvents() : undefined), [live]);
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    backupApi.options().then(
      (o) => !cancelled && (setOptions(o), setOptionsError(null)),
      (e: Error) => !cancelled && setOptionsError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [live, optionsTick]);
  useEffect(() => {
    if (lastNotification)
      useUiStore.getState().showNotice(`${lastNotification.title}: ${lastNotification.body}`);
  }, [lastNotification]);

  const reloadOptions = () => setOptionsTick((t) => t + 1);
  const demo = !live || options?.demo;

  return (
    <motion.section
      className="manage-panel bk-panel"
      aria-label="Backups and restore"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.18 }}
    >
      <header className="manage-header">
        <div className="manage-title">
          <h2>Backups &amp; Restore</h2>
          <p>
            {demo
              ? 'DEMO DATA: backups need real servers and databases.'
              : `Reuses your connected servers, databases and buckets · ${connected ? 'live' : 'reconnecting…'}`}
          </p>
        </div>
        <button type="button" onClick={() => useUiStore.getState().openBackups(null)}>
          Close <kbd>Esc</kbd>
        </button>
      </header>
      <nav className="bk-tabs" role="tablist" aria-label="Backup sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'is-active' : ''}
            onClick={() => go(t.id)}
          >
            {t.label}
            {t.id === 'notifications' && unread > 0 && (
              <span className="toolbar-count">{unread}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="bk-body">
        {optionsError && <p className="bk-error">{optionsError}</p>}
        {demo ? (
          <Empty title="Not available with demo data">
            <p>Start GRIDCITY without --demo and connect a server or a database to back it up.</p>
          </Empty>
        ) : (
          <>
            {tab === 'dashboard' && <Dashboard go={go} />}
            {tab === 'discover' && (
              <DiscoverTab
                onPick={(source) => {
                  setDraft(source);
                  go('jobs');
                }}
              />
            )}
            {tab === 'jobs' && (
              <JobsTab
                options={options}
                reloadOptions={reloadOptions}
                draft={draft}
                clearDraft={() => setDraft(null)}
              />
            )}
            {tab === 'history' && (
              <HistoryTab
                options={options}
                onRestore={(id) => {
                  setRestoreRun(id);
                  go('restore');
                }}
              />
            )}
            {tab === 'destinations' && (
              <DestinationsTab options={options} reloadOptions={reloadOptions} />
            )}
            {tab === 'restore' && (
              <RestoreTab options={options} runId={restoreRun} setRunId={setRestoreRun} />
            )}
            {tab === 'notifications' && (
              <NotificationsTab
                onOpenRun={(id) => {
                  setRestoreRun(null);
                  setOpenRun(id);
                }}
              />
            )}
          </>
        )}
      </div>
      <RunDrawerHost
        onRestore={(id) => {
          setRestoreRun(id);
          go('restore');
        }}
      />
    </motion.section>
  );
}

// A small shared slot so Notifications and the Dashboard can open run details.
let openRunListener: ((id: string | null) => void) | null = null;
const setOpenRun = (id: string | null) => openRunListener?.(id);

function RunDrawerHost({ onRestore }: { onRestore: (id: string) => void }) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    openRunListener = setId;
    return () => {
      openRunListener = null;
    };
  }, []);
  return id ? (
    <RunDetails
      runId={id}
      onClose={() => setId(null)}
      onRestore={(r) => {
        setId(null);
        onRestore(r);
      }}
    />
  ) : null;
}

function Dashboard({ go }: { go: (tab: BackupTab) => void }) {
  const { data, error } = useLoad(() => backupApi.overview());
  const operations = useBackupLive((s) => s.operations);
  const finished = useBackupLive((s) => s.finished);
  const active = Object.values(operations);
  const setUnread = useBackupLive((s) => s.setUnread);
  useEffect(() => {
    if (data) setUnread(data.unread);
  }, [data, setUnread]);

  if (error) return <p className="bk-error">{error}</p>;
  if (!data) return <p className="bk-muted">Loading…</p>;
  return (
    <div className="bk-dash">
      <HealthBanner data={data} go={go} />
      <div className="bk-kpis">
        <Kpi label="Backup jobs" value={String(data.jobs)} />
        <Kpi label="Succeeded (7 days)" value={String(data.last7Days.success)} />
        <Kpi
          label="Failed (7 days)"
          value={String(data.last7Days.failed + data.last7Days.partial)}
          tone={data.last7Days.failed + data.last7Days.partial > 0 ? 'bad' : undefined}
        />
        <Kpi label="Stored" value={formatBytes(data.storage.reduce((s, d) => s + d.bytes, 0))} />
        <Kpi label="Success rate (30 days)" value={rate(data)} />
      </div>
      <section className="bk-panel-block">
        <h3>Active</h3>
        {active.length === 0 && <p className="bk-muted">Nothing running.</p>}
        {active.map((op) => (
          <OperationCard key={op.id} op={op} />
        ))}
        {finished.slice(0, 3).map((op) => (
          <OperationCard key={op.id} op={op} showLog={false} />
        ))}
      </section>
      <div className="bk-dash-grid">
        <section className="bk-panel-block">
          <h3>Last 14 days</h3>
          <DailyChart daily={data.daily} />
        </section>
        <section className="bk-panel-block">
          <h3>Storage</h3>
          {data.storage.length === 0 && (
            <p className="bk-muted">
              No destination yet.{' '}
              <button type="button" className="bk-link" onClick={() => go('destinations')}>
                Add one
              </button>
            </p>
          )}
          <ul className="bk-list">
            {data.storage.map((s) => {
              const max = Math.max(...data.storage.map((x) => x.bytes), 1);
              return (
                <li key={s.destinationId}>
                  <div className="bk-op-dest-line">
                    <strong>{s.name}</strong>
                    <span className="bk-muted">
                      {s.kind} · {s.count} backups
                    </span>
                    <span>{formatBytes(s.bytes)}</span>
                  </div>
                  <div className="bk-bar is-static">
                    <span style={{ width: `${(s.bytes / max) * 100}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="bk-panel-block">
          <h3>Upcoming</h3>
          {data.upcoming.length === 0 && <p className="bk-muted">No scheduled backup.</p>}
          <ul className="bk-list">
            {data.upcoming.map((u) => (
              <li key={u.jobId}>
                <strong>{u.jobName}</strong>{' '}
                <span className="bk-muted">
                  {formatDate(u.at)} ({formatWhen(u.at)})
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="bk-panel-block">
          <h3>Recent activity</h3>
          {data.recent.length === 0 && (
            <p className="bk-muted">
              No backup yet.{' '}
              <button type="button" className="bk-link" onClick={() => go('discover')}>
                Discover what to back up
              </button>
            </p>
          )}
          <ul className="bk-list">
            {data.recent.map((r) => (
              <li key={r.id}>
                <button type="button" className="bk-link" onClick={() => setOpenRun(r.id)}>
                  <StatusBadge status={r.status} /> {r.jobName}
                </button>{' '}
                <span className="bk-muted">
                  {r.type} · {formatBytes(r.storedBytes)} · {formatWhen(r.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

const rate = (d: BackupDashboard) => {
  const total = d.last30Days.success + d.last30Days.failed + d.last30Days.partial;
  return total === 0 ? '—' : `${Math.round((d.last30Days.success / total) * 100)}%`;
};

function HealthBanner({ data, go }: { data: BackupDashboard; go: (tab: BackupTab) => void }) {
  const text = {
    healthy: 'All backups are healthy',
    warning: 'Some backups need attention',
    failing: 'Backups are failing',
    empty: 'Nothing is backed up yet',
  }[data.health];
  return (
    <div className={`bk-health is-${data.health}`}>
      <div>
        <strong>{text}</strong>
        {data.healthReasons.length > 0 && (
          <ul>
            {data.healthReasons.slice(0, 5).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {data.health === 'empty' && (
          <p>
            Discover finds databases, containers, volumes and folders on your connected servers.
          </p>
        )}
      </div>
      <div className="bk-actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => go(data.health === 'empty' ? 'discover' : 'jobs')}
        >
          {data.health === 'empty' ? 'Discover' : 'Backup jobs'}
        </button>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className={`bk-kpi${tone ? ` is-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DailyChart({ daily }: { daily: BackupDashboard['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.success + d.failed));
  return (
    <div className="bk-chart" role="img" aria-label="Backups per day: succeeded and failed">
      {daily.map((d) => (
        <div
          key={d.date}
          className="bk-chart-col"
          title={`${d.date}: ${d.success} succeeded, ${d.failed} failed`}
        >
          <div className="bk-chart-stack">
            {d.failed > 0 && (
              <span className="is-bad" style={{ height: `${(d.failed / max) * 100}%` }} />
            )}
            {d.success > 0 && (
              <span className="is-ok" style={{ height: `${(d.success / max) * 100}%` }} />
            )}
          </div>
          <i>{d.date.slice(8)}</i>
        </div>
      ))}
    </div>
  );
}

function DiscoverTab({ onPick }: { onPick: (source: Partial<SourceConfig>) => void }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof backupApi.discover>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [filter, setFilter] = useState('');
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    backupApi.discover().then(
      (found) => {
        if (cancelled) return;
        setResult(found);
        setError(null);
        setScanning(false);
      },
      (e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setScanning(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [round]);
  const scan = () => {
    setScanning(true);
    setRound((r) => r + 1);
  };

  const groups = useMemo(() => {
    const map = new Map<string, NonNullable<typeof result>['items']>();
    for (const item of result?.items ?? []) {
      if (
        filter &&
        !`${item.label} ${item.detail} ${item.where}`.toLowerCase().includes(filter.toLowerCase())
      )
        continue;
      const key = item.key.startsWith('resource:') ? 'Connected databases' : item.where;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [result, filter]);

  return (
    <section className="bk-section">
      <div className="bk-toolbar">
        <p className="bk-muted">
          Databases you connected, plus Docker containers, volumes and common folders on this
          machine and every connected server.
        </p>
        <div className="bk-inline">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            aria-label="Filter"
          />
          <button type="button" disabled={scanning} onClick={scan}>
            {scanning ? 'Scanning…' : 'Scan again'}
          </button>
        </div>
      </div>
      {error && <p className="bk-error">{error}</p>}
      {result?.problems.map((p) => (
        <p key={p.where} className="bk-warn">
          {p.where}: {p.message}
        </p>
      ))}
      {result && result.items.length === 0 && (
        <Empty title="Nothing found">
          <p>
            Connect a server or a database (Connect at the top of the city), or create a job for a
            folder or a custom command.
          </p>
        </Empty>
      )}
      {groups.map(([where, items]) => (
        <div key={where} className="bk-group">
          <h3>{where}</h3>
          <ul className="bk-discover">
            {items.map((item) => (
              <li key={item.key}>
                <div>
                  <strong>{item.label}</strong>
                  <span className="bk-muted">{item.detail}</span>
                  {item.key.startsWith('resource:') && (
                    <span className="bk-muted bk-mono">{item.where}</span>
                  )}
                </div>
                {item.coveredBy.length > 0 ? (
                  <span className="bk-badge is-ok" title={item.coveredBy.join(', ')}>
                    covered
                  </span>
                ) : null}
                <button type="button" onClick={() => onPick(item.source)}>
                  Back up…
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function NotificationsTab({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { data, error, reload } = useLoad(() => backupApi.notifications());
  const setUnread = useBackupLive((s) => s.setUnread);
  const markAll = async () => {
    const r = await backupApi.markRead('all');
    setUnread(r.unread);
    reload();
  };
  return (
    <section className="bk-section">
      <div className="bk-toolbar">
        <p className="bk-muted">
          Successes, failures, storage errors and restores. Email and chat follow your alert
          channels (Settings → Alerts → Backups).
        </p>
        <div className="bk-inline">
          <button type="button" onClick={() => useUiStore.getState().setSettingsOpen(true)}>
            Alert channels…
          </button>
          <button type="button" onClick={() => void markAll()}>
            Mark all read
          </button>
        </div>
      </div>
      {error && <p className="bk-error">{error}</p>}
      {data && data.length === 0 && <Empty title="No notifications" />}
      <ul className="bk-notes">
        {data?.map((n) => (
          <li key={n.id} className={`is-${n.level}${n.read ? '' : ' is-unread'}`}>
            <div>
              <strong>{n.title}</strong>
              <p>{n.body}</p>
              <span className="bk-muted">{formatDate(n.at)}</span>
            </div>
            {n.runId && (
              <button type="button" onClick={() => onOpenRun(n.runId!)}>
                Details
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
