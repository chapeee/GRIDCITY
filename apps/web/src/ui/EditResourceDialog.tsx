import type { Resource } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import {
  editResource,
  fetchCredentials,
  removeResource,
  type OneTimeSecrets,
} from '../data/resource-api';
import { useUiStore } from './ui-store';

/**
 * Edit a resources.yaml entry: display name, district and tags, or remove it.
 * New credentials can be pasted here (saved encrypted). Other connection
 * details are changed by removing and connecting again. An RDS
 * region or S3 account entry covers every instance or bucket it found.
 */
const PASSWORD_KINDS = new Set(['postgres', 'mysql', 'mongodb', 'redis', 'mssql']);
const KEY_KINDS = new Set(['s3', 'rds', 'loadbalancer']);

export function EditResourceDialog() {
  const sourceId = useUiStore((store) => store.editResourceId);
  const resources = useFleetStore((store) => store.resources);
  const members = useMemo(
    () => resources.filter((r) => r.sourceId === sourceId),
    [resources, sourceId],
  );
  return (
    <AnimatePresence>
      {sourceId && members.length > 0 && (
        <EditResourceForm key={sourceId} sourceId={sourceId} members={members} />
      )}
    </AnimatePresence>
  );
}

function EditResourceForm({ sourceId, members }: { sourceId: string; members: Resource[] }) {
  const first = members[0]!;
  const single = members.length === 1 && first.id === sourceId;
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const districts = useMemo(
    () =>
      [...new Set([...hosts.map((h) => h.district), ...resources.map((r) => r.district)])].sort(),
    [hosts, resources],
  );
  const [name, setName] = useState(first.name);
  const [district, setDistrict] = useState(first.district);
  const [tags, setTags] = useState(first.tags.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [secrets, setSecrets] = useState<OneTimeSecrets>({});
  const [saved, setSaved] = useState<{ password: boolean; accessKey: boolean } | null>(null);
  const usesPassword = PASSWORD_KINDS.has(first.kind);
  const usesKeys = KEY_KINDS.has(first.kind);
  useEffect(() => {
    if (!usesPassword && !usesKeys) return;
    fetchCredentials(sourceId).then(setSaved, () => setSaved(null));
  }, [sourceId, usesPassword, usesKeys]);
  const close = () => useUiStore.getState().setEditResourceId(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await editResource(
        sourceId,
        {
          ...(single ? { name: name.trim() } : {}),
          district: district.trim(),
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
        secrets,
      );
      useUiStore.getState().showNotice(`Saved ${single ? name.trim() : sourceId}.`);
      close();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeResource(sourceId);
      useUiStore.getState().focusHost(null);
      useUiStore.getState().showNotice(`Removed ${sourceId} from resources.yaml.`);
      close();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.form
        className="dialog edit-host-dialog"
        role="dialog"
        aria-label={`Edit ${single ? first.name : sourceId}`}
        initial={{ y: 12 }}
        animate={{ y: 0 }}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="audit-header">
          <h2>Edit {single ? first.name : sourceId}</h2>
          <button type="button" onClick={close}>
            Close <kbd>Esc</kbd>
          </button>
        </header>
        {!single && (
          <p className="settings-help">
            This entry covers {members.length} {first.kind === 's3' ? 'buckets' : 'instances'}:{' '}
            {members.map((m) => m.name).join(', ')}. District and tags apply to all of them.
          </p>
        )}
        <fieldset disabled={busy}>
          {single && (
            <label className="settings-field">
              <span>Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
              />
              <span className="settings-help">
                id stays “{sourceId}”: place and history are kept
              </span>
            </label>
          )}
          <label className="settings-field">
            <span>District</span>
            <input
              value={district}
              onChange={(event) => setDistrict(event.target.value)}
              list="edit-resource-districts"
              required
              maxLength={60}
            />
            <datalist id="edit-resource-districts">
              {districts.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
          </label>
          <label className="settings-field">
            <span>Tags</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="prod, billing"
            />
          </label>
        </fieldset>
        {usesPassword && (
          <fieldset disabled={busy}>
            <legend>Password</legend>
            <label className="settings-field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={secrets.password ?? ''}
                onChange={(event) => setSecrets((s) => ({ ...s, password: event.target.value }))}
                placeholder={saved?.password ? 'saved · type to replace' : 'paste it here'}
              />
              <span className="settings-help">Saved encrypted. Empty keeps the current one.</span>
            </label>
          </fieldset>
        )}
        {usesKeys && (
          <fieldset disabled={busy}>
            <legend>Access keys</legend>
            <label className="settings-field">
              <span>Access key</span>
              <input
                autoComplete="off"
                spellCheck={false}
                value={secrets.accessKeyId ?? ''}
                onChange={(event) => setSecrets((s) => ({ ...s, accessKeyId: event.target.value }))}
                placeholder={saved?.accessKey ? 'saved · type to replace' : 'AKIA… or DO00…'}
              />
            </label>
            <label className="settings-field">
              <span>Secret key</span>
              <input
                type="password"
                autoComplete="new-password"
                value={secrets.secretAccessKey ?? ''}
                onChange={(event) =>
                  setSecrets((s) => ({ ...s, secretAccessKey: event.target.value }))
                }
              />
              <span className="settings-help">
                Both are needed to replace the pair. Empty keeps the current keys.
              </span>
            </label>
          </fieldset>
        )}
        <p className="settings-help">To change the address, remove it and connect it again.</p>
        {error && <p className="audit-error">{error}</p>}
        <footer className="hud-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            Save
          </button>
          {confirmRemove ? (
            <button
              type="button"
              className="button-danger"
              onClick={() => void remove()}
              disabled={busy}
            >
              Remove from resources.yaml?
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmRemove(true)} disabled={busy}>
              Remove…
            </button>
          )}
        </footer>
      </motion.form>
    </motion.div>
  );
}
