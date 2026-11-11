import type { Resource } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { editResource, removeResource } from '../data/resource-api';
import { useUiStore } from './ui-store';

/**
 * Edit a resources.yaml entry: display name, district and tags, or remove it.
 * Connection details are changed by removing and connecting again. An RDS
 * region or S3 account entry covers every instance or bucket it found.
 */
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
  const close = () => useUiStore.getState().setEditResourceId(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await editResource(sourceId, {
        ...(single ? { name: name.trim() } : {}),
        district: district.trim(),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
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
      onMouseDown={(event) => event.target === event.currentTarget && close()}
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
        <p className="settings-help">
          To change the address or credentials, remove it and connect it again.
        </p>
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
