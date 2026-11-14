import { useEffect, useState } from 'react';
import { updateSteps, useUpdateStore } from '../data/update-api';
import { useServerLink } from '../data/server-link';
import { readStoredJson, writeStoredJson } from './browser-storage';
import { useUiStore } from './ui-store';

const DISMISSED_KEY = 'gridcity.update.dismissed';
/** The server checks GitHub once a day; the page asks the server every hour. */
const REFRESH_MS = 60 * 60 * 1000;
/** While the server's first check (10 s after start) is still pending. */
const FIRST_CHECK_RETRY_MS = 6_000;

/**
 * "GRIDCITY 1.0.1 is available": shown at the top until closed. Closing hides
 * that version only; the next release shows again. Settings → Updates turns
 * the check off.
 */
export function UpdateNotice() {
  const live = useServerLink((link) => link.source === 'server');
  const info = useUpdateStore((store) => store.info);
  // The "rendering is slow" question uses the same corner of the screen: it goes first.
  const liteQuestion = useUiStore((store) => store.liteSuggestionVisible);
  const [dismissed, setDismissed] = useState(() =>
    readStoredJson<string | null>(DISMISSED_KEY, null),
  );
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    if (!live) return;
    const load = () =>
      void useUpdateStore
        .getState()
        .load()
        .catch(() => undefined);
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [live]);

  // Right after the app starts, the server has not asked GitHub yet (it waits a
  // few seconds): ask again soon instead of waiting an hour.
  const firstCheckPending = Boolean(info?.enabled && info.checkedAt === null && !info.error);
  useEffect(() => {
    if (!live || !firstCheckPending) return;
    const timer = setTimeout(
      () =>
        void useUpdateStore
          .getState()
          .load()
          .catch(() => undefined),
      FIRST_CHECK_RETRY_MS,
    );
    return () => clearTimeout(timer);
  }, [live, firstCheckPending, info]);

  if (!live || liteQuestion || !info?.available || !info.latest || dismissed === info.latest) {
    return null;
  }
  const steps = updateSteps(info);
  const close = () => {
    writeStoredJson(DISMISSED_KEY, info.latest);
    setDismissed(info.latest);
  };

  // Bottom left, above the shortcut hints: the top center belongs to alerts.
  return (
    <section className="banner banner-update" aria-label="New version available" aria-live="polite">
      <div className="banner-row">
        <p>
          <strong>GRIDCITY {info.latest} is available.</strong> You have {info.current}.
        </p>
        <span className="update-actions">
          {info.releaseUrl && (
            <a href={info.releaseUrl} target="_blank" rel="noopener noreferrer">
              What's new
            </a>
          )}
          <button type="button" className="link-button" onClick={() => setShowSteps((v) => !v)}>
            How to update
          </button>
          <button
            type="button"
            className="link-button"
            aria-label="Hide until the next version"
            onClick={close}
          >
            ✕
          </button>
        </span>
      </div>
      {showSteps && (
        <div className="update-steps">
          <p>{steps.text}</p>
          {steps.command && <code>{steps.command}</code>}
        </div>
      )}
    </section>
  );
}
