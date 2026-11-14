import { useEffect, useState } from 'react';
import { updateSteps, useUpdateStore } from '../data/update-api';
import { useServerLink } from '../data/server-link';

const clock = (at: number) =>
  new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Settings → Updates: the version you run, whether a newer one is out, and the
 * switch for the daily check (the one request GRIDCITY makes to GitHub).
 */
export function UpdatesSettings() {
  const live = useServerLink((link) => link.source === 'server');
  const info = useUpdateStore((store) => store.info);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (live)
      void useUpdateStore
        .getState()
        .load()
        .catch(() => undefined);
  }, [live]);

  if (!live || !info) return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const steps = info.available ? updateSteps(info) : null;

  return (
    <fieldset className="settings-form settings-updates" disabled={busy}>
      <legend>Updates</legend>
      <p className="settings-help">
        {info.available ? (
          <>
            <strong>GRIDCITY {info.latest} is available</strong> (you have {info.current}).{' '}
            {info.releaseUrl && (
              <a href={info.releaseUrl} target="_blank" rel="noopener noreferrer">
                What's new
              </a>
            )}
          </>
        ) : info.enabled && info.latest ? (
          <>You have the latest version, {info.current}.</>
        ) : (
          <>You have GRIDCITY {info.current}.</>
        )}
        {info.enabled && info.checkedAt && <> Checked {clock(info.checkedAt)}.</>}
        {info.enabled && info.error && <> Could not check: {info.error}.</>}
      </p>
      {steps && (
        <div className="update-steps">
          <p>{steps.text}</p>
          {steps.command && <code>{steps.command}</code>}
        </div>
      )}
      <label className="settings-check">
        <input
          type="checkbox"
          checked={info.enabled}
          disabled={info.lockedOff}
          onChange={(event) =>
            void run(() => useUpdateStore.getState().setEnabled(event.target.checked))
          }
        />
        Check for new versions once a day
      </label>
      <p className="settings-help">
        {info.lockedOff
          ? 'Turned off by GRIDCITY_UPDATE_CHECK=off.'
          : "Asks GitHub's public releases page. Nothing about you or your servers is sent."}
      </p>
      {info.enabled && (
        <button
          type="button"
          className="link-button"
          onClick={() => void run(() => useUpdateStore.getState().checkNow())}
        >
          {busy ? 'Checking…' : 'Check now'}
        </button>
      )}
      {error && (
        <p className="audit-error" role="status">
          {error}
        </p>
      )}
    </fieldset>
  );
}
