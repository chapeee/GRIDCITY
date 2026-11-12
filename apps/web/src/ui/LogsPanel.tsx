import { AnimatePresence, motion } from 'motion/react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { useServerLink } from '../data/server-link';
import { useUiStore } from './ui-store';

interface HostLogResult {
  hostId: string;
  hostName: string;
  ok: boolean;
  lines: { source: string; text: string }[];
  truncated: boolean;
  notes: string[];
}

const RANGES = ['15m', '1h', '6h', '24h', '7d'] as const;
const SOURCES = [
  ['journal', 'Journal'],
  ['files', 'Log files'],
  ['containers', 'Containers'],
] as const;

/** Shows each match of the query in a line, highlighted. */
function highlight(text: string, query: string, regex: boolean): ReactNode {
  let pattern: RegExp;
  try {
    pattern = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch {
    return text;
  }
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || match[0] === '') break;
    parts.push(text.slice(last, match.index), <mark key={match.index}>{match[0]}</mark>);
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/**
 * Search the logs of every server at once: the journal, the files in
 * /var/log and the containers' logs, over SSH, read-only. Results come back
 * grouped by server, newest last, with the match highlighted.
 */
export function LogsPanel() {
  const open = useUiStore((store) => store.logsOpen);
  const hosts = useFleetStore((store) => store.hosts);
  const live = useServerLink((link) => link.source === 'server');
  const [query, setQuery] = useState('');
  const [since, setSince] = useState<(typeof RANGES)[number]>('1h');
  const [regex, setRegex] = useState(false);
  const [sources, setSources] = useState<string[]>(['journal', 'files', 'containers']);
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [results, setResults] = useState<HostLogResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState({ query: '', regex: false });

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setSearching(true);
    setError(null);
    try {
      const response = await fetch('/api/logs/search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, since, regex, sources, hostIds }),
      });
      const body = (await response.json()) as {
        results?: HostLogResult[];
        error?: string;
        problems?: string[];
      };
      if (!response.ok)
        throw new Error(
          body.problems?.join(' ') ?? body.error ?? `search failed (${response.status})`,
        );
      setResults(body.results ?? []);
      setSearched({ query, regex });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const total = results?.reduce((sum, r) => sum + r.lines.length, 0) ?? 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="security-panel logs-panel"
          aria-label="Search logs"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <header className="audit-header">
            <h2>Search logs</h2>
            <div className="audit-actions">
              <button type="button" onClick={() => useUiStore.getState().setLogsOpen(false)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </header>
          {!live ? (
            <p className="audit-note">DEMO DATA: there are no real logs to search.</p>
          ) : (
            <form className="logs-form" onSubmit={(event) => void search(event)}>
              <div className="logs-query">
                <input
                  autoFocus
                  value={query}
                  spellCheck={false}
                  placeholder={regex ? 'error|timeout|refused' : 'connection refused'}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button
                  type="submit"
                  className="button-primary"
                  disabled={searching || query.trim().length < 2}
                >
                  {searching ? 'Searching…' : 'Search'}
                </button>
              </div>
              <div className="logs-options">
                <span className="segmented">
                  {RANGES.map((range) => (
                    <button
                      key={range}
                      type="button"
                      aria-pressed={since === range}
                      onClick={() => setSince(range)}
                    >
                      {range}
                    </button>
                  ))}
                </span>
                {SOURCES.map(([value, label]) => (
                  <label key={value} className="alerts-check">
                    <input
                      type="checkbox"
                      checked={sources.includes(value)}
                      onChange={(event) =>
                        setSources((current) =>
                          event.target.checked
                            ? [...current, value]
                            : current.filter((s) => s !== value),
                        )
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
                <label className="alerts-check">
                  <input
                    type="checkbox"
                    checked={regex}
                    onChange={(event) => setRegex(event.target.checked)}
                  />
                  <span>Regular expression</span>
                </label>
              </div>
              <p className="settings-help">
                The time range filters journal and container lines exactly; for log files it picks
                the files changed in that window and searches their recent lines.
              </p>
              <div className="logs-hosts">
                <span className="finding-actions-label">Servers</span>
                <button
                  type="button"
                  aria-pressed={hostIds.length === 0}
                  onClick={() => setHostIds([])}
                >
                  All ({hosts.length})
                </button>
                {hosts.map((host) => (
                  <button
                    key={host.id}
                    type="button"
                    aria-pressed={hostIds.includes(host.id)}
                    onClick={() =>
                      setHostIds((current) =>
                        current.includes(host.id)
                          ? current.filter((id) => id !== host.id)
                          : [...current, host.id],
                      )
                    }
                  >
                    {host.name}
                  </button>
                ))}
              </div>
            </form>
          )}
          {error && <p className="audit-error">{error}</p>}
          {results && (
            <p className="security-intro">
              {total} matching line{total === 1 ? '' : 's'} on{' '}
              {results.filter((r) => r.lines.length > 0).length} of {results.length} server
              {results.length === 1 ? '' : 's'}.
            </p>
          )}
          {results?.map((result) => (
            <section key={result.hostId} className="logs-host">
              <h3>
                <button
                  type="button"
                  className="hud-link"
                  onClick={() => useUiStore.getState().showBuilding(result.hostId)}
                >
                  {result.hostName}
                </button>
                <span className="alerts-meta">
                  {result.lines.length} line{result.lines.length === 1 ? '' : 's'}
                  {result.truncated && ' (showing the newest)'}
                </span>
              </h3>
              {result.notes.map((note) => (
                <p key={note} className="settings-help is-warning">
                  {note}
                </p>
              ))}
              {result.lines.length > 0 && (
                <pre className="logs-lines">
                  {result.lines.map((line, index) => (
                    <span key={index} className="logs-line">
                      <span className="logs-source">{line.source}</span>
                      {highlight(line.text, searched.query, searched.regex)}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              )}
            </section>
          ))}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
