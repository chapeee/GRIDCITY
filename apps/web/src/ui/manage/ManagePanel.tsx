import type { ExploreInfo, ManageMode } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { exploreApi } from '../../data/explore-api';
import { useUiStore } from '../ui-store';
import './manage.css';
import { ManageErrorBoundary } from './ManageErrorBoundary';
import { MongoManager } from './MongoManager';
import { RedisManager } from './RedisManager';
import { S3Manager } from './S3Manager';
import { SqlManager } from './SqlManager';

const KIND_LABELS: Record<ExploreInfo['kind'], string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mssql: 'SQL Server',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  redis: 'Redis',
  s3: 'Object storage',
};

/**
 * The Manage view: a full workspace for one database, Redis or storage
 * account. Read-only until "Changes" is switched on for this resource; the
 * server enforces that, and audits every change.
 */
export function ManagePanel() {
  const target = useUiStore((store) => store.manageTarget);
  return (
    <AnimatePresence>
      {target && (
        <ManageErrorBoundary key={target.id} onClose={() => useUiStore.getState().closeManage()}>
          <ManageWorkspace id={target.id} bucket={target.bucket} />
        </ManageErrorBoundary>
      )}
    </AnimatePresence>
  );
}

function ManageWorkspace({ id, bucket }: { id: string; bucket?: string }) {
  const api = useMemo(() => exploreApi(id), [id]);
  const [info, setInfo] = useState<ExploreInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [switching, setSwitching] = useState(false);

  // State changes only in the promise callbacks (never synchronously inside the effect).
  const load = useCallback(() => {
    api
      .info()
      .then((loaded) => {
        setInfo(loaded);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const close = () => useUiStore.getState().closeManage();

  const setMode = async (mode: ManageMode) => {
    setSwitching(true);
    try {
      await api.setMode(mode);
      setInfo((current) => (current ? { ...current, mode } : current));
      setConfirmWrite(false);
      useUiStore
        .getState()
        .showNotice(
          mode === 'write'
            ? `Changes are on for ${info?.name}. Every change is audited.`
            : `${info?.name} is read-only again.`,
        );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <motion.section
      className="manage-panel"
      role="dialog"
      aria-label={`Manage ${info?.name ?? id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
    >
      <header className="manage-header">
        <div className="manage-title">
          <h2>{info?.name ?? id}</h2>
          {info && (
            <p>
              {/* "PostgreSQL 17.11" already names the engine; the kind label is for when it is unknown. */}
              {info.server ?? KIND_LABELS[info.kind]} ·{' '}
              <span className="manage-target">{info.target}</span>
            </p>
          )}
        </div>
        {info && (
          <div className="manage-mode">
            <span className={`mode-badge ${info.mode === 'write' ? 'is-write' : ''}`}>
              {info.mode === 'write' ? 'Changes on · audited' : 'Read-only'}
            </span>
            {info.mode === 'read' ? (
              confirmWrite ? (
                <span className="mode-confirm">
                  Allow editing data in {info.name}?
                  <button
                    type="button"
                    className="is-danger"
                    disabled={switching}
                    onClick={() => void setMode('write')}
                  >
                    Yes, allow changes
                  </button>
                  <button type="button" onClick={() => setConfirmWrite(false)}>
                    Keep read-only
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmWrite(true)}>
                  Allow changes…
                </button>
              )
            ) : (
              <button type="button" disabled={switching} onClick={() => void setMode('read')}>
                Back to read-only
              </button>
            )}
          </div>
        )}
        <button type="button" onClick={close}>
          Close <kbd>Esc</kbd>
        </button>
      </header>

      {error && (
        <div className="manage-error" role="alert">
          {error}{' '}
          <button type="button" className="link-button" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {info && (
        <div className="manage-body">
          {(info.kind === 'postgres' ||
            info.kind === 'mysql' ||
            info.kind === 'mssql' ||
            info.kind === 'sqlite') && <SqlManager api={api} info={info} />}
          {info.kind === 'mongodb' && <MongoManager api={api} info={info} />}
          {info.kind === 'redis' && <RedisManager api={api} info={info} />}
          {info.kind === 's3' && <S3Manager api={api} info={info} initialBucket={bucket} />}
        </div>
      )}
      {!info && !error && <p className="manage-loading">Connecting…</p>}
    </motion.section>
  );
}
