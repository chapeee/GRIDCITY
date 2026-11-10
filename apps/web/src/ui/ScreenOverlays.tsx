import { useEffect } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { performanceBudget } from '../design/tokens';
import { usePerfStore } from './perf-store';
import { useUiStore } from './ui-store';

/** How long a notice stays on screen, ms. */
const NOTICE_DURATION_MS = 3500;

/** Project name plus the permanent "DEMO DATA" badge in demo mode. */
export function TopBar() {
  const dataMode = useFleetStore((store) => store.dataMode);
  const protocolMismatch = useFleetStore((store) => store.protocolMismatch);
  const renderingLost = useUiStore((store) => store.renderingLost);
  const ambientMode = useUiStore((store) => store.ambientMode);
  return (
    <header className="top-bar">
      <span className="project-name">{__PROJECT_NAME__}</span>
      {dataMode === 'demo' && (
        <span className="demo-badge" role="status">
          DEMO DATA <small>simulated fleet · not real servers</small>
        </span>
      )}
      {ambientMode && (
        <span className="ambient-badge" role="status">
          AMBIENT <small>touring hosts that need attention · Esc to stop</small>
        </span>
      )}
      {renderingLost && (
        <span className="alert-badge" role="alert">
          Graphics context lost: the city is not updating. Reload the page.
        </span>
      )}
      {protocolMismatch && (
        <span className="alert-badge" role="alert">
          Server protocol changed. Reload the page.
        </span>
      )}
    </header>
  );
}

/** Keyboard hints, bottom left. */
export function ShortcutHints() {
  return (
    <p className="shortcut-hints" aria-hidden="true">
      <kbd>Ctrl</kbd>
      <kbd>K</kbd> commands <span className="separator">·</span> <kbd>Tab</kbd> next host{' '}
      <span className="separator">·</span> <kbd>Esc</kbd> overview{' '}
      <span className="separator">·</span> <kbd>A</kbd> ambient
    </p>
  );
}

/** Dev performance overlay: frame time, fps, draw calls. */
export function PerfOverlay() {
  const visible = useUiStore((store) => store.perfOverlayVisible);
  const liteMode = useUiStore((store) => store.liteMode);
  const stats = usePerfStore();
  const hostCount = useFleetStore((store) => store.hosts.length);
  if (!visible) return null;
  const slow = stats.frameMs > performanceBudget.liteSuggestFrameMs;
  return (
    <dl className="perf-overlay" aria-label="Performance">
      <dt>frame</dt>
      <dd className={slow ? 'is-warning' : undefined}>{stats.frameMs.toFixed(1)} ms</dd>
      <dt>fps</dt>
      <dd>{stats.fps}</dd>
      <dt>draws</dt>
      <dd>{stats.drawCalls}</dd>
      <dt>tris</dt>
      <dd>{stats.triangles.toLocaleString()}</dd>
      <dt>hosts</dt>
      <dd>{hostCount}</dd>
      <dt>mode</dt>
      <dd>{liteMode ? 'lite' : 'full'}</dd>
    </dl>
  );
}

/** Offered once when frames stay slow; never switches on its own. */
export function LiteModeSuggestion() {
  const visible = useUiStore((store) => store.liteSuggestionVisible);
  const frameMs = usePerfStore((store) => store.frameMs);
  const { setLiteMode, dismissLiteSuggestion } = useUiStore.getState();
  if (!visible) return null;
  return (
    <div className="toast" role="status">
      <p>
        Rendering is slow ({frameMs.toFixed(0)} ms per frame). Lite mode turns off bloom and
        particles.
      </p>
      <div className="toast-actions">
        <button type="button" className="button-primary" onClick={() => setLiteMode(true)}>
          Switch to lite mode
        </button>
        <button type="button" onClick={dismissLiteSuggestion}>
          Keep full mode
        </button>
      </div>
    </div>
  );
}

/** Short transient messages. */
export function NoticeToast() {
  const notice = useUiStore((store) => store.notice);
  const clearNotice = useUiStore((store) => store.clearNotice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => clearNotice(notice.id), NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [notice, clearNotice]);
  if (!notice) return null;
  return (
    <div className="toast toast-notice" role="status">
      {notice.text}
    </div>
  );
}
