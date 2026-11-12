import { isMaintenance, type ThreatsView, type UpcomingItem } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useFleetStore } from '../data/fleet-store';
import { backupsApi, threatsApi, type BackupExpectation } from '../data/threats-api';
import { FindingActions } from './FindingActions';
import { useUiStore } from './ui-store';

const KIND_LABEL: Record<UpcomingItem['kind'], string> = {
  certificate: 'Certificate',
  domain: 'Domain',
  'disk-full': 'Disk full',
  backup: 'Backup',
};

const STATUS_LABEL: Record<UpcomingItem['status'], string> = {
  overdue: 'overdue',
  urgent: 'this week',
  soon: 'this month',
  ok: 'fine',
  unknown: 'unknown',
};

function when(at: number | null): string {
  if (at === null) return '—';
  const days = Math.round((at - Date.now()) / 86_400_000);
  const date = new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  if (days === 0) return `today · ${date}`;
  return days > 0
    ? `in ${days} day${days === 1 ? '' : 's'} · ${date}`
    : `${-days} day${days === -1 ? '' : 's'} ago · ${date}`;
}

/**
 * Upcoming: everything dated that will need attention (certificates and
 * domains that expire, disks that fill up, backups that are due), soonest
 * first, plus the backup checks themselves.
 */
export function UpcomingPanel() {
  const open = useUiStore((store) => store.upcomingOpen);
  const live = useFleetStore((store) => store.threats);
  const names = useFleetStore(
    useShallow((store) => ({ hosts: store.hosts, resources: store.resources })),
  );
  const [view, setView] = useState<ThreatsView | null>(null);
  const [backups, setBackups] = useState<BackupExpectation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    Promise.all([threatsApi.load(), backupsApi.list()]).then(
      ([loaded, list]) => {
        setView(loaded);
        setBackups(list.backups);
        setError(null);
      },
      (reason: unknown) => setError((reason as Error).message),
    );
  }, []);

  useEffect(() => {
    if (open) reload();
  }, [open, live, reload]);

  const nameOf = (id: string) =>
    names.hosts.find((h) => h.id === id)?.name ??
    names.resources.find((r) => r.id === id)?.name ??
    id;
  const attention = (view?.findings ?? []).filter((f) => isMaintenance(f) && f.status === 'open');
  const items = view?.upcoming ?? [];

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="security-panel upcoming-panel"
          aria-label="Upcoming"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <header className="audit-header">
            <h2>Upcoming</h2>
            <div className="audit-actions">
              <button type="button" onClick={() => useUiStore.getState().setUpcomingOpen(false)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </header>
          {view?.demo && (
            <p className="audit-note">
              DEMO DATA: simulated dates. On your servers these come from real certificates,
              domains, disks and backups.
            </p>
          )}
          <p className="security-intro">
            Certificates and domains that expire, disks that will fill up, and backups that are due.
            You are alerted 30, 7 and 1 days ahead, and when a backup is late.
          </p>
          {error && <p className="audit-error">{error}</p>}

          {attention.length > 0 && (
            <ul className="security-list">
              {attention.map((finding) => (
                <li key={finding.id} className={`security-row is-${finding.severity}`}>
                  <div className="security-row-head">
                    <span className={`security-chip is-${finding.severity}`}>
                      {finding.severity}
                    </span>
                    <strong>{finding.title}</strong>
                    <span className="security-meta">{nameOf(finding.targetId)}</span>
                  </div>
                  <div className="security-body">
                    <p>{finding.detail}</p>
                    <p className="security-advice">
                      <span>What to do</span> {finding.advice}
                    </p>
                    <FindingActions finding={finding} onView={setView} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3 className="upcoming-heading">Calendar</h3>
          {items.length === 0 ? (
            <p className="alerts-empty">
              Nothing dated yet. HTTPS probes add certificates and domains, servers add disk
              forecasts after a few hours of history, and backup checks below add backups.
            </p>
          ) : (
            <ul className="upcoming-list">
              {items.map((item) => (
                <li
                  key={`${item.kind}:${item.targetId}:${item.label}`}
                  className={`upcoming-row is-${item.status}`}
                >
                  <span className="upcoming-kind">{KIND_LABEL[item.kind]}</span>
                  <button
                    type="button"
                    className="hud-link"
                    onClick={() => useUiStore.getState().showBuilding(item.targetId)}
                  >
                    {item.label}
                  </button>
                  <span className="upcoming-when">{when(item.at)}</span>
                  <span className={`upcoming-status is-${item.status}`}>
                    {STATUS_LABEL[item.status]}
                  </span>
                  <span className="upcoming-detail">{item.detail}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="upcoming-backups">
            <div className="alerts-block-title">
              <h3 className="upcoming-heading">Backup checks</h3>
              {!view?.demo && !adding && (
                <button type="button" className="button-primary" onClick={() => setAdding(true)}>
                  + Add backup check
                </button>
              )}
            </div>
            {adding && (
              <BackupForm
                names={names}
                onDone={(changed) => {
                  setAdding(false);
                  if (changed) reload();
                }}
              />
            )}
            {backups.length === 0 && !adding && (
              <p className="alerts-empty">
                Tell GRIDCITY where a backup should appear (a file pattern on a server or a prefix
                in a bucket) and how often: it warns when one is late, missing or suspiciously
                small.
              </p>
            )}
            <ul className="alerts-list">
              {backups.map((backup) => (
                <li key={backup.id} className="alerts-row">
                  <div className="alerts-row-main">
                    <span className="alerts-type">
                      {backup.kind === 'file' ? 'File' : 'Bucket'}
                    </span>
                    <strong>{backup.name}</strong>
                    <span className="alerts-meta">
                      {nameOf(backup.targetId)} · {backup.path || '(whole bucket)'} · every{' '}
                      {backup.maxAgeHours} h
                    </span>
                  </div>
                  <div className="alerts-actions">
                    <button
                      type="button"
                      onClick={() => {
                        backupsApi
                          .remove(backup.id)
                          .then(reload, (reason: unknown) => setError((reason as Error).message));
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function BackupForm({
  names,
  onDone,
}: {
  names: {
    hosts: { id: string; name: string }[];
    resources: { id: string; name: string; kind: string }[];
  };
  onDone: (changed: boolean) => void;
}) {
  const targets = [
    ...names.hosts.map((h) => ({
      id: h.id,
      label: `${h.name} (server: file)`,
      kind: 'file' as const,
    })),
    ...names.resources
      .filter((r) => r.kind === 's3')
      .map((r) => ({ id: r.id, label: `${r.name} (bucket)`, kind: 's3' as const })),
  ];
  const [name, setName] = useState('Nightly backup');
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [path, setPath] = useState('');
  const [hours, setHours] = useState('26');
  const [minMb, setMinMb] = useState('0.001');
  const [problem, setProblem] = useState<string | null>(null);
  const kind = targets.find((t) => t.id === targetId)?.kind ?? 'file';

  const save = async () => {
    setProblem(null);
    try {
      await backupsApi.save({
        name,
        targetId,
        kind,
        path,
        maxAgeHours: Math.round(Number(hours)),
        minBytes: Math.round(Number(minMb) * 1024 * 1024),
      });
      onDone(true);
    } catch (reason) {
      setProblem((reason as Error).message);
    }
  };

  return (
    <div className="alerts-form">
      <label className="alerts-field">
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="alerts-field">
        <span>Where</span>
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
        </select>
      </label>
      <label className="alerts-field">
        <span>{kind === 'file' ? 'File pattern' : 'Object prefix'}</span>
        <input
          value={path}
          spellCheck={false}
          placeholder={kind === 'file' ? '/var/backups/db-*.sql.gz' : 'nightly/'}
          onChange={(event) => setPath(event.target.value)}
        />
        <small>
          {kind === 'file'
            ? 'absolute path, * and ? allowed; the newest match counts'
            : 'the newest object under it counts; empty for the whole bucket'}
        </small>
      </label>
      <label className="alerts-field">
        <span>Expected every</span>
        <input
          type="number"
          min={1}
          value={hours}
          onChange={(event) => setHours(event.target.value)}
        />
        <small>hours (26 for a nightly backup gives it two hours of slack)</small>
      </label>
      <label className="alerts-field">
        <span>At least</span>
        <input
          type="number"
          min={0}
          step="any"
          value={minMb}
          onChange={(event) => setMinMb(event.target.value)}
        />
        <small>MB; smaller means the backup probably failed</small>
      </label>
      {problem && <p className="audit-error">{problem}</p>}
      <div className="alerts-actions">
        <button
          type="button"
          className="button-primary"
          disabled={!targetId}
          onClick={() => void save()}
        >
          Save and check
        </button>
        <button type="button" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
