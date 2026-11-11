import type { StatusThresholds } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { fetchSettings, saveSettings, sendTestAlert, type SettingsView } from '../data/history-api';
import { useUiStore } from './ui-store';
import { requestNotificationPermission } from './use-alerts';

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
  const notificationsEnabled = useUiStore((store) => store.notificationsEnabled);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const toggleNotifications = async (enabled: boolean) => {
    if (enabled) {
      const granted = await requestNotificationPermission();
      setPermission(granted);
      if (granted !== 'granted') return;
    }
    useUiStore.getState().setNotificationsEnabled(enabled);
  };
  const [webhookDraft, setWebhookDraft] = useState('');
  const [webhookStatus, setWebhookStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const saveWebhook = async (url: string | null) => {
    setWebhookStatus(null);
    try {
      setView(await saveSettings({ alerts: { webhookUrl: url } }));
      setWebhookDraft('');
      setWebhookStatus({ ok: true, text: url ? 'Saved (encrypted).' : 'Removed.' });
    } catch (reason) {
      setWebhookStatus({ ok: false, text: (reason as Error).message });
    }
  };
  const testWebhook = async () => {
    setWebhookStatus(null);
    try {
      await sendTestAlert();
      setWebhookStatus({ ok: true, text: 'Test message sent. Check your channel.' });
    } catch (reason) {
      setWebhookStatus({ ok: false, text: (reason as Error).message });
    }
  };

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

            <fieldset>
              <legend>Alerts</legend>
              <label className="settings-field">
                <span>Desktop notifications</span>
                <input
                  type="checkbox"
                  checked={notificationsEnabled}
                  disabled={permission === 'unsupported' || permission === 'denied'}
                  onChange={(event) => void toggleNotifications(event.target.checked)}
                />
                <span className="settings-unit" />
                <span className="settings-help">
                  {permission === 'unsupported'
                    ? 'this browser has no notifications'
                    : permission === 'denied'
                      ? 'blocked by the browser; allow notifications for this site first'
                      : 'when a server or resource goes offline, degraded, or recovers (this browser only)'}
                </span>
              </label>
              <label className="settings-field">
                <span>Webhook</span>
                <input
                  type="password"
                  autoComplete="off"
                  disabled={!view?.editable}
                  value={webhookDraft}
                  onChange={(event) => setWebhookDraft(event.target.value)}
                  placeholder={
                    view?.alerts?.webhookConfigured
                      ? view.alerts.fromEnvironment
                        ? 'set by ALERT_WEBHOOK_URL · paste to override'
                        : 'saved · paste a new URL to replace'
                      : 'https://hooks.slack.com/… · Discord · ntfy'
                  }
                />
                <span className="settings-unit" />
                <span className="settings-help">
                  Slack, Discord, Mattermost, ntfy or anything taking JSON. Saved encrypted on this
                  machine; one message per server per minute.
                </span>
              </label>
              <div className="settings-inline-actions">
                <button
                  type="button"
                  disabled={!view?.editable || webhookDraft.trim() === ''}
                  onClick={() => void saveWebhook(webhookDraft.trim())}
                >
                  Save webhook
                </button>
                <button
                  type="button"
                  disabled={!view?.editable || !view.alerts?.webhookConfigured}
                  onClick={() => void testWebhook()}
                >
                  Send a test
                </button>
                {view?.alerts?.webhookConfigured && !view.alerts.fromEnvironment && (
                  <button type="button" onClick={() => void saveWebhook(null)}>
                    Remove
                  </button>
                )}
              </div>
              {webhookStatus && (
                <p className={webhookStatus.ok ? 'settings-saved' : 'audit-error'} role="status">
                  {webhookStatus.text}
                </p>
              )}
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
