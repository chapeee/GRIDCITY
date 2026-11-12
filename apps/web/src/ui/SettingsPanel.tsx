import type { StatusThresholds } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { fetchSettings, saveSettings, type SettingsView } from '../data/history-api';
import { AlertsSettings } from './AlertsSettings';
import { useUiStore } from './ui-store';

type ThresholdKey = keyof StatusThresholds;

const THRESHOLD_FIELDS: {
  key: ThresholdKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  help: string;
}[] = [
  {
    key: 'cpuDegradedPercent',
    label: 'CPU warning',
    unit: '%',
    min: 1,
    max: 100,
    help: 'CPU above this…',
  },
  {
    key: 'cpuDegradedPolls',
    label: '…for polls in a row',
    unit: 'polls',
    min: 1,
    max: 1000,
    help: 'so one spike never warns',
  },
  {
    key: 'memoryDegradedPercent',
    label: 'Memory warning',
    unit: '%',
    min: 1,
    max: 100,
    help: 'memory used above this',
  },
  {
    key: 'diskDegradedPercent',
    label: 'Disk warning',
    unit: '%',
    min: 1,
    max: 100,
    help: 'any disk fuller than this',
  },
  {
    key: 'pollIntervalMs',
    label: 'Poll every',
    unit: 'ms',
    min: 500,
    max: 600_000,
    help: 'how often each server is measured',
  },
  {
    key: 'staleAfterPolls',
    label: 'Stale after',
    unit: 'polls',
    min: 1,
    max: 1000,
    help: 'missed polls before data freezes',
  },
];

/**
 * Settings: how long history is kept, and what "over a threshold"
 * (degraded, the amber warning) means for every server. Per-server
 * overrides live in Edit. Thresholds are written to hosts.yaml (comments
 * kept), so the file stays the source of truth.
 */
export function SettingsPanel() {
  const open = useUiStore((store) => store.settingsOpen);
  const [view, setView] = useState<SettingsView | null>(null);
  const [retention, setRetention] = useState(7);
  const [values, setValues] = useState<Partial<Record<ThresholdKey, number>>>({});
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    fetchSettings()
      .then((loaded) => {
        setStatus(null);
        setView(loaded);
        setRetention(loaded.app.historyRetentionDays);
        setValues({ ...loaded.thresholds });
      })
      .catch((reason: unknown) => setStatus({ kind: 'error', text: (reason as Error).message }));
  }, [open]);

  const save = async () => {
    if (!view) return;
    setSaving(true);
    setStatus(null);
    try {
      const changed = Object.fromEntries(
        Object.entries(values).filter(
          ([key, value]) => value !== view.thresholds[key as ThresholdKey],
        ),
      );
      const saved = await saveSettings({
        app: { historyRetentionDays: retention },
        ...(Object.keys(changed).length > 0 ? { thresholds: changed } : {}),
      });
      setView(saved);
      setStatus({
        kind: 'saved',
        text: 'Saved. The city uses the new thresholds from the next poll.',
      });
    } catch (reason) {
      setStatus({ kind: 'error', text: (reason as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="settings-panel"
          aria-label="Settings"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <header className="audit-header">
            <h2>Settings</h2>
            <div className="audit-actions">
              <button type="button" onClick={() => useUiStore.getState().setSettingsOpen(false)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </header>
          {view && !view.editable && (
            <p className="audit-note">DEMO DATA: settings are shown but cannot be saved.</p>
          )}

          <AlertsSettings />

          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={!view?.editable || saving}>
              <legend>History</legend>
              <label className="settings-field">
                <span>Keep history for</span>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={retention}
                  onChange={(event) => setRetention(Number(event.target.value))}
                />
                <span className="settings-unit">days</span>
                <span className="settings-help">
                  metrics and incidents; older data is deleted (1–90)
                </span>
              </label>
            </fieldset>

            <fieldset disabled={!view?.editable || saving}>
              <legend>Warnings for every server</legend>
              <p className="settings-help">
                A server turns amber (degraded) when any rule is broken. Override per server with
                Edit.
              </p>
              {THRESHOLD_FIELDS.map((field) => (
                <label key={field.key} className="settings-field">
                  <span>{field.label}</span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={values[field.key] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.key]: Number(event.target.value),
                      }))
                    }
                  />
                  <span className="settings-unit">{field.unit}</span>
                  <span className="settings-help">{field.help}</span>
                </label>
              ))}
              {view?.hostsFile && <p className="settings-help">Saved to {view.hostsFile}</p>}
            </fieldset>

            {status && (
              <p
                className={status.kind === 'error' ? 'audit-error' : 'settings-saved'}
                role="status"
              >
                {status.text}
              </p>
            )}
            <footer className="hud-actions">
              <button type="submit" className="button-primary" disabled={!view?.editable || saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </footer>
          </form>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
