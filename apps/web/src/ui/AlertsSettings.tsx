import {
  ALERT_CHANNEL_SPECS,
  ALERT_CHANNEL_TYPES,
  DEFAULT_ALERT_EVENTS,
  validateAlertChannel,
  type AlertChannelInput,
  type AlertChannelType,
  type AlertChannelView,
  type AlertEvents,
  type AlertsView,
} from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import {
  alertsApi,
  disablePush,
  enablePush,
  pushActiveHere,
  pushUnavailableReason,
  storedDeviceId,
} from '../data/alerts-api';
import { useServerLink } from '../data/server-link';
import { useUiStore } from './ui-store';
import { requestNotificationPermission } from './use-alerts';

type Status = { ok: boolean; text: string } | null;

const EVENT_LABELS: [keyof AlertEvents, string][] = [
  ['offline', 'Offline'],
  ['degraded', 'Degraded'],
  ['recovered', 'Recovered'],
  ['security', 'Attacks'],
];

function ago(at: number | null): string {
  if (!at) return 'nothing sent yet';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'sent just now';
  if (seconds < 3600) return `sent ${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `sent ${Math.round(seconds / 3600)} h ago`;
  return `sent ${new Date(at).toLocaleDateString()}`;
}

/**
 * Settings → Alerts: Web Push for this browser, and channels (email, chat,
 * push services) the server uses while nobody has the app open.
 */
export function AlertsSettings() {
  const inBrowserDemo = useServerLink((link) => link.source !== 'server');
  const [view, setView] = useState<AlertsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; type: AlertChannelType } | null>(
    null,
  );
  const [picking, setPicking] = useState(false);

  const reload = useCallback(() => {
    alertsApi.load().then(
      (loaded) => {
        setView(loaded);
        setLoadError(null);
      },
      (reason: unknown) => setLoadError((reason as Error).message),
    );
  }, []);

  useEffect(() => {
    if (!inBrowserDemo) reload();
  }, [inBrowserDemo, reload]);

  if (inBrowserDemo) {
    return (
      <section className="alerts-settings" aria-label="Alerts">
        <h3>Alerts</h3>
        <p className="settings-help">DEMO DATA: alerts are not sent.</p>
      </section>
    );
  }

  const editable = view?.editable ?? false;
  const channel = editing?.id ? view?.channels.find((c) => c.id === editing.id) : undefined;

  return (
    <section className="alerts-settings" aria-label="Alerts">
      <div className="alerts-heading">
        <h3>Alerts</h3>
        <p className="settings-help">
          Sent by the server the moment something goes offline, degraded or recovers, even when
          nobody has {__PROJECT_NAME__} open. Everything here is saved encrypted on this machine.
        </p>
      </div>
      {loadError && <p className="audit-error">{loadError}</p>}

      <ThisBrowser view={view} onView={setView} />

      <div className="alerts-block">
        <div className="alerts-block-title">
          <h4>Channels</h4>
          {editable && !editing && !picking && (
            <button type="button" className="button-primary" onClick={() => setPicking(true)}>
              + Add channel
            </button>
          )}
        </div>

        {picking && (
          <div className="alerts-picker" role="list">
            {ALERT_CHANNEL_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="listitem"
                className="alerts-picker-item"
                onClick={() => {
                  setPicking(false);
                  setEditing({ id: null, type });
                }}
              >
                <strong>{ALERT_CHANNEL_SPECS[type].label}</strong>
                <span>{ALERT_CHANNEL_SPECS[type].hint}</span>
              </button>
            ))}
            <button
              type="button"
              className="alerts-picker-cancel"
              onClick={() => setPicking(false)}
            >
              Cancel
            </button>
          </div>
        )}

        {editing && (
          <ChannelForm
            key={editing.id ?? editing.type}
            type={editing.type}
            saved={channel}
            onDone={(next) => {
              if (next) setView(next);
              setEditing(null);
            }}
          />
        )}

        {view && view.channels.length === 0 && !editing && !picking && (
          <p className="alerts-empty">
            No channels yet. Email, Slack, Discord, Telegram, Teams and phone push (ntfy, Pushover)
            take a minute to set up.
          </p>
        )}

        <ul className="alerts-list">
          {view?.channels
            .filter((item) => item.id !== editing?.id)
            .map((item) => (
              <ChannelRow
                key={item.id}
                channel={item}
                editable={editable}
                onEdit={() => setEditing({ id: item.id, type: item.type })}
                onView={setView}
                onTested={reload}
              />
            ))}
        </ul>
      </div>
    </section>
  );
}

function ThisBrowser({
  view,
  onView,
}: {
  view: AlertsView | null;
  onView: (view: AlertsView) => void;
}) {
  const unavailable = pushUnavailableReason();
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const thisId = storedDeviceId();

  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    void pushActiveHere(view).then((value) => {
      if (!cancelled) setActive(value);
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
    } catch (reason) {
      setStatus({ ok: false, text: (reason as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      if (!view?.push.publicKey) throw new Error('The server has no push key.');
      const result = await enablePush(view.push.publicKey);
      onView(result.view);
      setActive(true);
      // Push replaces the in-tab notifications, so nothing is shown twice.
      useUiStore.getState().setNotificationsEnabled(false);
      await alertsApi.testDevice(result.device.id);
      setStatus({ ok: true, text: 'On. A test notification is on its way.' });
    });

  const turnOff = () =>
    run(async () => {
      const next = await disablePush();
      if (next) onView(next);
      setActive(false);
      setStatus({ ok: true, text: 'Off for this browser.' });
    });

  const test = () =>
    run(async () => {
      if (!thisId) return;
      await alertsApi.testDevice(thisId);
      setStatus({ ok: true, text: 'Test sent. It should pop up in a few seconds.' });
    });

  const others = view?.push.devices.filter((device) => device.id !== thisId) ?? [];

  return (
    <div className="alerts-block">
      <div className="alerts-block-title">
        <h4>Browser notifications</h4>
      </div>
      {unavailable ? (
        <InTabFallback reason={unavailable} />
      ) : (
        <div className={`alerts-browser${active ? ' is-on' : ''}`}>
          <span className="alerts-dot" aria-hidden />
          <div className="alerts-browser-text">
            <strong>{active ? 'On for this browser' : 'Off for this browser'}</strong>
            <span>
              {active
                ? 'Desktop notifications arrive even with this tab closed, while the browser runs.'
                : 'Get Windows, macOS or Android notifications from the server, even with this tab closed.'}
            </span>
          </div>
          <div className="alerts-actions">
            {active ? (
              <>
                <button type="button" disabled={busy} onClick={() => void test()}>
                  Send a test
                </button>
                <button type="button" disabled={busy} onClick={() => void turnOff()}>
                  Turn off
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button-primary"
                disabled={busy || !view?.editable}
                onClick={() => void turnOn()}
              >
                {busy ? 'Turning on…' : 'Turn on'}
              </button>
            )}
          </div>
        </div>
      )}
      {status && (
        <p className={status.ok ? 'settings-saved' : 'audit-error'} role="status">
          {status.text}
        </p>
      )}
      {others.length > 0 && (
        <ul className="alerts-list is-compact">
          {others.map((device) => (
            <li key={device.id} className="alerts-row">
              <div className="alerts-row-main">
                <span className="alerts-type">Push</span>
                <strong>{device.label}</strong>
                <span className={device.lastError ? 'alerts-error' : 'alerts-meta'}>
                  {device.lastError ??
                    `added ${new Date(device.createdAt).toLocaleDateString()} · ${ago(device.lastSentAt)}`}
                </span>
              </div>
              <div className="alerts-actions">
                <RemoveButton
                  disabled={!view?.editable}
                  onConfirm={async () => onView(await alertsApi.removeDevice(device.id))}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** No Web Push here (plain http on a LAN address, old browser): notify while the tab is open. */
function InTabFallback({ reason }: { reason: string }) {
  const enabled = useUiStore((store) => store.notificationsEnabled);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const toggle = async (next: boolean) => {
    if (next) {
      const granted = await requestNotificationPermission();
      setPermission(granted);
      if (granted !== 'granted') return;
    }
    useUiStore.getState().setNotificationsEnabled(next);
  };
  return (
    <>
      <p className="settings-help is-warning">Push with the tab closed {reason}.</p>
      <label className="alerts-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={permission === 'unsupported' || permission === 'denied'}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>
          Notify while a {__PROJECT_NAME__} tab is open
          {permission === 'denied' &&
            ' (blocked by the browser: allow notifications for this site)'}
        </span>
      </label>
    </>
  );
}

function ChannelRow({
  channel,
  editable,
  onEdit,
  onView,
  onTested,
}: {
  channel: AlertChannelView;
  editable: boolean;
  onEdit: () => void;
  onView: (view: AlertsView) => void;
  onTested: () => void;
}) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const spec = ALERT_CHANNEL_SPECS[channel.type];
  const locked = !editable || channel.fromEnvironment;

  const test = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await alertsApi.testChannel(channel.id);
      setStatus({ ok: true, text: 'Test sent. Check it arrived.' });
      onTested();
    } catch (reason) {
      setStatus({ ok: false, text: (reason as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    try {
      onView(
        await alertsApi.editChannel(channel.id, {
          type: channel.type,
          name: channel.name,
          enabled: !channel.enabled,
          events: channel.events,
          settings: channel.settings,
        }),
      );
    } catch (reason) {
      setStatus({ ok: false, text: (reason as Error).message });
    }
  };

  const target =
    channel.type === 'email'
      ? channel.settings.to
      : channel.type === 'telegram'
        ? `chat ${channel.settings.chatId ?? ''}`
        : channel.settings.server;

  return (
    <li className={`alerts-row${channel.enabled ? '' : ' is-paused'}`}>
      <div className="alerts-row-main">
        <span className="alerts-type">{spec.label.split(' (')[0]!.split(',')[0]}</span>
        <strong>{channel.name}</strong>
        {target && <span className="alerts-meta">{target}</span>}
        <span className="alerts-events">
          {EVENT_LABELS.filter(([key]) => channel.events[key]).map(([key, label]) => (
            <span key={key} className={`alerts-chip is-${key}`}>
              {label}
            </span>
          ))}
        </span>
        <span className={channel.lastError ? 'alerts-error' : 'alerts-meta'}>
          {!channel.enabled ? 'paused' : (channel.lastError ?? ago(channel.lastSentAt))}
        </span>
        {channel.fromEnvironment && <span className="alerts-meta">from ALERT_WEBHOOK_URL</span>}
      </div>
      <div className="alerts-actions">
        <button type="button" disabled={busy || !editable} onClick={() => void test()}>
          {busy ? 'Sending…' : 'Test'}
        </button>
        {!locked && (
          <>
            <button type="button" onClick={onEdit}>
              Edit
            </button>
            <button type="button" onClick={() => void toggle()}>
              {channel.enabled ? 'Pause' : 'Resume'}
            </button>
            <RemoveButton
              onConfirm={async () => onView(await alertsApi.removeChannel(channel.id))}
            />
          </>
        )}
      </div>
      {status && (
        <p
          className={`alerts-row-status ${status.ok ? 'settings-saved' : 'audit-error'}`}
          role="status"
        >
          {status.text}
        </p>
      )}
    </li>
  );
}

function RemoveButton({
  onConfirm,
  disabled,
}: {
  onConfirm: () => Promise<void>;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? 'button-danger' : undefined}
      disabled={disabled}
      onClick={() => (armed ? void onConfirm() : setArmed(true))}
    >
      {armed ? 'Really remove?' : 'Remove'}
    </button>
  );
}

function ChannelForm({
  type: initialType,
  saved,
  onDone,
}: {
  type: AlertChannelType;
  saved?: AlertChannelView;
  onDone: (view: AlertsView | null) => void;
}) {
  const type = saved?.type ?? initialType;
  const spec = ALERT_CHANNEL_SPECS[type];
  const [name, setName] = useState(saved?.name ?? spec.label.split(' (')[0]!.split(',')[0]!);
  const [events, setEvents] = useState<AlertEvents>(saved?.events ?? DEFAULT_ALERT_EVENTS);
  const [settings, setSettings] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of spec.fields) {
      initial[field.key] = saved?.settings[field.key] ?? (saved ? '' : (field.default ?? ''));
    }
    return initial;
  });
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);

  const input = (): AlertChannelInput => ({
    type,
    name,
    enabled: saved?.enabled ?? true,
    events,
    settings: Object.fromEntries(
      Object.entries(settings).filter(([, value]) => value.trim() !== ''),
    ),
  });

  const check = (): boolean => {
    const problems = validateAlertChannel(input(), saved ? { secretsSet: saved.secretsSet } : null);
    if (problems.length > 0) setStatus({ ok: false, text: problems.join(' ') });
    return problems.length === 0;
  };

  const test = async () => {
    setStatus(null);
    if (!check()) return;
    setBusy('test');
    try {
      await alertsApi.testDraft(input(), saved?.id ?? null);
      setStatus({ ok: true, text: 'Test sent. If it arrived, save the channel.' });
    } catch (reason) {
      setStatus({ ok: false, text: (reason as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setStatus(null);
    if (!check()) return;
    setBusy('save');
    try {
      onDone(
        saved
          ? await alertsApi.editChannel(saved.id, input())
          : await alertsApi.addChannel(input()),
      );
    } catch (reason) {
      setStatus({ ok: false, text: (reason as Error).message });
      setBusy(null);
    }
  };

  return (
    <div
      className="alerts-form"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div className="alerts-form-title">
        <strong>{saved ? `Edit ${saved.name}` : spec.label}</strong>
        <span>{spec.hint}</span>
      </div>
      <label className="alerts-field">
        <span>Name</span>
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      {spec.fields.map((field) => {
        const kept = field.kind === 'secret' && saved?.secretsSet.includes(field.key);
        return (
          <label key={field.key} className="alerts-field">
            <span>
              {field.label}
              {field.required && !kept && <em aria-label="required"> *</em>}
            </span>
            {field.kind === 'select' ? (
              <select
                value={settings[field.key] || field.default || ''}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, [field.key]: event.target.value }))
                }
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={
                  field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text'
                }
                autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
                spellCheck={false}
                value={settings[field.key] ?? ''}
                placeholder={kept ? 'saved · leave empty to keep' : field.placeholder}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            )}
            {field.hint && <small>{field.hint}</small>}
          </label>
        );
      })}
      <div className="alerts-field">
        <span>Tell me when</span>
        <div className="alerts-event-toggles">
          {EVENT_LABELS.map(([key, label]) => (
            <label key={key} className="alerts-check">
              <input
                type="checkbox"
                checked={events[key]}
                onChange={(event) =>
                  setEvents((current) => ({ ...current, [key]: event.target.checked }))
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>
      {status && (
        <p className={status.ok ? 'settings-saved' : 'audit-error'} role="status">
          {status.text}
        </p>
      )}
      <div className="alerts-actions">
        <button type="button" disabled={busy !== null} onClick={() => void test()}>
          {busy === 'test' ? 'Sending…' : 'Send a test'}
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={busy !== null}
          onClick={() => void save()}
        >
          {busy === 'save' ? 'Saving…' : saved ? 'Save changes' : 'Save channel'}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
