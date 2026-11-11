import { runbookMatches, type Host, type Runbook, type RunResult } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { runOnServers, type RunResponse } from '../data/runbook-api';
import { useServerLink } from '../data/server-link';
import { StatusDot } from './StatusDot';
import { useUiStore } from './ui-store';

/**
 * Run a saved runbook, or a command typed once, on one server or many. The
 * user picks the servers (by district, by tag, one by one), sees exactly
 * what will run, confirms, and gets one row per server with the exit code
 * and output. Nothing runs before the click; every run lands in the audit
 * log. Read-only runbooks are marked; anything else is yours to judge.
 */
export function RunbookPanel() {
  const panel = useUiStore((store) => store.runbookPanel);
  return (
    <AnimatePresence>{panel && <RunbookPanelBody key="runbooks" preset={panel} />}</AnimatePresence>
  );
}

function RunbookPanelBody({ preset }: { preset: { hostIds: string[]; runbookId: string | null } }) {
  const hosts = useFleetStore((store) => store.hosts);
  const states = useFleetStore((store) => store.states);
  const runbooks = useFleetStore((store) => store.runbooks);
  const dataMode = useFleetStore((store) => store.dataMode);
  const source = useServerLink((store) => store.source);
  const canRun = dataMode === 'real' && source === 'server';

  const [runbookId, setRunbookId] = useState<string>(preset.runbookId ?? '');
  const [command, setCommand] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preset.hostIds));
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const runbook = runbooks.find((entry) => entry.id === runbookId) ?? null;
  const effectiveCommand = runbook ? runbook.command : command.trim();
  const connected = (host: Host) => {
    const status = states[host.id]?.status;
    return status === 'online' || status === 'degraded';
  };
  const applicable = useMemo(
    () => hosts.filter((host) => !runbook || runbookMatches(runbook, host)),
    [hosts, runbook],
  );
  const byDistrict = useMemo(() => {
    const groups = new Map<string, Host[]>();
    for (const host of applicable) {
      const list = groups.get(host.district) ?? [];
      list.push(host);
      groups.set(host.district, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [applicable]);
  const tags = useMemo(
    () =>
      [...new Set(applicable.flatMap((host) => host.tags))]
        .filter((t) => !t.startsWith('demo'))
        .sort(),
    [applicable],
  );

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectMany = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids)
        if (on) next.add(id);
        else next.delete(id);
      return next;
    });

  const close = () => useUiStore.getState().closeRunbooks();
  const chosen = applicable.filter((host) => selected.has(host.id));
  const ready = canRun && effectiveCommand.length > 0 && chosen.length > 0 && !running;

  const run = async () => {
    setConfirming(false);
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
      const result = await runOnServers({
        ...(runbook ? { runbookId: runbook.id } : { command: effectiveCommand }),
        hostIds: chosen.map((host) => host.id),
      });
      setResponse(result);
      setOpen(new Set(result.results.filter((r) => !r.ok).map((r) => r.hostId)));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <motion.section
      className="runbook-panel"
      aria-label="Runbooks"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.18 }}
    >
      <header className="audit-header">
        <h2>Runbooks</h2>
        <div className="audit-actions">
          <button type="button" onClick={close}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
      </header>
      {!canRun && (
        <p className="audit-note">
          {dataMode === 'demo'
            ? 'DEMO DATA: runbooks are listed, but there are no real servers to run them on.'
            : 'Runbooks need the local server (not the in-browser demo).'}
        </p>
      )}

      <div className="runbook-grid">
        <section className="runbook-column" aria-label="What to run">
          <h3>What</h3>
          <ul className="runbook-list">
            {runbooks.map((entry) => (
              <li key={entry.id}>
                <label className={`runbook-choice${runbookId === entry.id ? ' is-chosen' : ''}`}>
                  <input
                    type="radio"
                    name="runbook"
                    checked={runbookId === entry.id}
                    onChange={() => {
                      setRunbookId(entry.id);
                      setResponse(null);
                    }}
                  />
                  <span className="runbook-name">
                    {entry.name}
                    {entry.readOnly && <small> read-only</small>}
                    {entry.builtin && <small> built in</small>}
                  </span>
                  {entry.description && (
                    <span className="runbook-description">{entry.description}</span>
                  )}
                </label>
              </li>
            ))}
            <li>
              <label className={`runbook-choice${runbookId === '' ? ' is-chosen' : ''}`}>
                <input
                  type="radio"
                  name="runbook"
                  checked={runbookId === ''}
                  onChange={() => {
                    setRunbookId('');
                    setResponse(null);
                  }}
                />
                <span className="runbook-name">A command, this once</span>
              </label>
            </li>
          </ul>
          {runbook ? (
            <pre className="approval-command" aria-label="Command">
              {runbook.command}
            </pre>
          ) : (
            <textarea
              className="runbook-command"
              rows={4}
              placeholder="uptime && df -h /"
              value={command}
              onChange={(event) => {
                setCommand(event.target.value);
                setResponse(null);
              }}
              spellCheck={false}
            />
          )}
          <p className="settings-help">
            Runs with <code>sh -c</code> as each server&apos;s user, over the connection already
            open. No prompts: add <code>-y</code> or <code>-n</code> where a tool would ask.
          </p>
        </section>

        <section className="runbook-column" aria-label="Where to run">
          <h3>
            Where <small>{chosen.length} selected</small>
          </h3>
          <div className="runbook-quick">
            <button
              type="button"
              onClick={() =>
                selectMany(
                  applicable.map((h) => h.id),
                  true,
                )
              }
            >
              All
            </button>
            <button type="button" onClick={() => setSelected(new Set())}>
              None
            </button>
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                title={`Select every server tagged ${tag}`}
                onClick={() =>
                  selectMany(
                    applicable.filter((h) => h.tags.includes(tag)).map((h) => h.id),
                    true,
                  )
                }
              >
                #{tag}
              </button>
            ))}
          </div>
          {byDistrict.map(([district, members]) => (
            <fieldset key={district} className="runbook-district">
              <legend>
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    selectMany(
                      members.map((h) => h.id),
                      !members.every((h) => selected.has(h.id)),
                    )
                  }
                >
                  {district}
                </button>
              </legend>
              {members.map((host) => (
                <label key={host.id} className="runbook-host">
                  <input
                    type="checkbox"
                    checked={selected.has(host.id)}
                    onChange={() => toggle(host.id)}
                  />
                  <StatusDot
                    status={states[host.id]?.status ?? 'unknown'}
                    stale={states[host.id]?.stale ?? false}
                  />
                  <span>{host.name}</span>
                  {!connected(host) && <small>not connected</small>}
                </label>
              ))}
            </fieldset>
          ))}
          {applicable.length === 0 && (
            <p className="settings-help">This runbook applies to no server in the city.</p>
          )}
        </section>
      </div>

      <footer className="hud-actions runbook-actions">
        {confirming ? (
          <>
            <span className="runbook-confirm">
              Run on {chosen.length} server{chosen.length === 1 ? '' : 's'}
              {runbook && !runbook.readOnly ? ' (this command may change things)' : ''}?
            </span>
            <button type="button" className="button-primary" onClick={() => void run()}>
              Yes, run
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button-primary"
            disabled={!ready}
            onClick={() => setConfirming(true)}
          >
            {running
              ? 'Running…'
              : `Run on ${chosen.length} server${chosen.length === 1 ? '' : 's'}`}
          </button>
        )}
      </footer>

      {error && <p className="audit-error">{error}</p>}
      {response && <Results response={response} open={open} setOpen={setOpen} />}
    </motion.section>
  );
}

function Results({
  response,
  open,
  setOpen,
}: {
  response: RunResponse;
  open: Set<string>;
  setOpen(next: Set<string>): void;
}) {
  const failed = response.results.filter((r) => !r.ok).length;
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  return (
    <section className="runbook-results" aria-label="Results">
      <h3>
        Results <small>{failed === 0 ? 'all succeeded' : `${failed} failed`}</small>
      </h3>
      <ul>
        {response.results.map((result) => (
          <li key={result.hostId} className={result.ok ? 'is-ok' : 'is-failed'}>
            <button
              type="button"
              className="runbook-result-row"
              onClick={() => toggle(result.hostId)}
            >
              <span className="runbook-result-host">{result.hostName}</span>
              <span className="runbook-result-code">{describeResult(result)}</span>
              <span className="runbook-result-time">{(result.durationMs / 1000).toFixed(1)} s</span>
            </button>
            {open.has(result.hostId) && (
              <pre className="runbook-output">
                {result.stdout}
                {result.stderr && (
                  <>
                    {result.stdout ? '\n' : ''}
                    <span className="runbook-stderr">{result.stderr}</span>
                  </>
                )}
                {!result.stdout && !result.stderr && !result.error && '(no output)'}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function describeResult(result: RunResult): string {
  if (result.error) return result.error;
  return result.exitCode === 0 ? 'exit 0' : `exit ${result.exitCode ?? '?'}`;
}

/** Runbooks that apply to a host, for the HUD button and the palette. */
export function runbooksFor(runbooks: readonly Runbook[], host: Host): Runbook[] {
  return runbooks.filter((runbook) => runbookMatches(runbook, host));
}
