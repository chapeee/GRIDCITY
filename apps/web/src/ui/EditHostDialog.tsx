import { AnimatePresence, motion } from 'motion/react';
import type { Host } from '@app/shared';
import { useMemo, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { editHost, removeHost, type HostPatch } from '../data/history-api';
import { useUiStore } from './ui-store';

type OverrideKey =
  'cpuDegradedPercent' | 'cpuDegradedPolls' | 'memoryDegradedPercent' | 'diskDegradedPercent';

const OVERRIDES: { key: OverrideKey; label: string; unit: string; min: number; max: number }[] = [
  { key: 'cpuDegradedPercent', label: 'CPU warning above', unit: '%', min: 1, max: 100 },
  { key: 'cpuDegradedPolls', label: '…for polls in a row', unit: 'polls', min: 1, max: 1000 },
  { key: 'memoryDegradedPercent', label: 'Memory warning above', unit: '%', min: 1, max: 100 },
  { key: 'diskDegradedPercent', label: 'Disk warning above', unit: '%', min: 1, max: 100 },
];

/**
 * Edit a server: display name, district, tags, and its own warning
 * thresholds (empty = use the defaults from Settings). The id never changes,
 * so the server keeps its place in the city and its history. Writes
 * hosts.yaml in place (comments kept); the city reloads at once.
 */
export function EditHostDialog() {
  const hostId = useUiStore((store) => store.editHostId);
  const host = useFleetStore((store) => store.hosts.find((h) => h.id === hostId));
  // One form per server: its fields start from that server's current values.
  return <AnimatePresence>{host && <EditHostForm key={host.id} host={host} />}</AnimatePresence>;
}

function EditHostForm({ host }: { host: Host }) {
  const hosts = useFleetStore((store) => store.hosts);
  // Derived outside the selector: a new array per call would re-render forever.
  const districts = useMemo(() => [...new Set(hosts.map((h) => h.district))].sort(), [hosts]);
  const defaults = useFleetStore((store) => store.thresholds);
  const dataMode = useFleetStore((store) => store.dataMode);
  const [name, setName] = useState(host.name);
  const [district, setDistrict] = useState(host.district);
  const [tags, setTags] = useState(host.tags.join(', '));
  const [overrides, setOverrides] = useState<Partial<Record<OverrideKey, string>>>(() =>
    Object.fromEntries(
      Object.entries(host.thresholds ?? {}).map(([key, value]) => [key, String(value)]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const close = () => useUiStore.getState().setEditHostId(null);
  const editable = dataMode === 'real';

  const save = async () => {
    setBusy(true);
    setError(null);
    const thresholds = Object.fromEntries(
      Object.entries(overrides)
        .filter(([, value]) => value !== undefined && value.trim() !== '')
        .map(([key, value]) => [key, Number(value)]),
    );
    const patch: HostPatch = {
      name: name.trim(),
      district: district.trim(),
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      thresholds: Object.keys(thresholds).length > 0 ? thresholds : null,
    };
    try {
      await editHost(host.id, patch);
      useUiStore.getState().showNotice(`Saved ${patch.name}.`);
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
      await removeHost(host.id);
      useUiStore.getState().focusHost(null);
      useUiStore.getState().showNotice(`Removed ${host.name} from hosts.yaml.`);
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
        aria-label={`Edit ${host.name}`}
        initial={{ y: 12 }}
        animate={{ y: 0 }}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="audit-header">
          <h2>Edit {host.name}</h2>
          <button type="button" onClick={close}>
            Close <kbd>Esc</kbd>
          </button>
        </header>
        {!editable && <p className="audit-note">DEMO DATA: changes cannot be saved.</p>}
        <fieldset disabled={!editable || busy}>
          <label className="settings-field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
            />
            <span className="settings-help">id stays “{host.id}”: place and history are kept</span>
          </label>
          <label className="settings-field">
            <span>District</span>
            <input
              value={district}
              onChange={(event) => setDistrict(event.target.value)}
              list="edit-host-districts"
              required
              maxLength={60}
            />
            <datalist id="edit-host-districts">
              {districts.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
            <span className="settings-help">pick one or type a new district</span>
          </label>
          <label className="settings-field">
            <span>Tags</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="web, prod"
            />
            <span className="settings-help">comma separated, searchable in Ctrl+K</span>
          </label>
        </fieldset>
        <fieldset disabled={!editable || busy}>
          <legend>Warnings for this server</legend>
          <p className="settings-help">Empty = the default from Settings.</p>
          {OVERRIDES.map((field) => (
            <label key={field.key} className="settings-field">
              <span>{field.label}</span>
              <input
                type="number"
                min={field.min}
                max={field.max}
                value={overrides[field.key] ?? ''}
                placeholder={String(defaults[field.key])}
                onChange={(event) =>
                  setOverrides((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
              <span className="settings-unit">{field.unit}</span>
            </label>
          ))}
        </fieldset>
        {error && <p className="audit-error">{error}</p>}
        <footer className="hud-actions">
          <button type="submit" className="button-primary" disabled={!editable || busy}>
            Save
          </button>
          {editable &&
            (confirmRemove ? (
              <button
                type="button"
                className="button-danger"
                onClick={() => void remove()}
                disabled={busy}
              >
                Remove from hosts.yaml?
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmRemove(true)} disabled={busy}>
                Remove…
              </button>
            ))}
        </footer>
      </motion.form>
    </motion.div>
  );
}
