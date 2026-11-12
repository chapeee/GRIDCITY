import { useEffect, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { fetchMeta } from '../data/server-api';
import { useServerLink } from '../data/server-link';
import { useHostImport } from './use-host-import';
import { useUiStore } from './ui-store';

/**
 * Banners for states the user must never misread: a lost server link, an
 * expired session, or a broken hosts.yaml. Stacked at the top center.
 */
export function StatusBanners() {
  return (
    <div className="status-banners" aria-live="polite">
      <ConnectionBanner />
      <ConfigErrorBanner />
    </div>
  );
}

function ConnectionBanner() {
  const { state, source } = useServerLink();
  if (source !== 'server' || state === 'open') return null;

  if (state === 'unauthorized') {
    return (
      <div className="banner banner-alert" role="alert">
        <strong>Session expired.</strong> The server was restarted or the link is outdated. Open the
        new URL printed in the server console.
      </div>
    );
  }
  if (state === 'reconnecting') {
    return (
      <div className="banner banner-alert" role="alert">
        <strong>Lost connection to the local server.</strong> Reconnecting… Hosts on screen freeze
        as their data goes stale.
      </div>
    );
  }
  return <div className="banner">Connecting to the local server…</div>;
}

function ConfigErrorBanner() {
  const lastError = useFleetStore((store) => store.lastError);
  const [collapsed, setCollapsed] = useState(false);
  if (!lastError) return null;
  const [headline, ...details] = lastError.split('\n');
  return (
    <div className="banner banner-alert" role="alert">
      <div className="banner-row">
        <strong>{headline}</strong>
        {details.length > 0 && (
          <button type="button" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? 'Show details' : 'Hide details'}
          </button>
        )}
      </div>
      {!collapsed && details.length > 0 && (
        <pre className="banner-details">{details.join('\n')}</pre>
      )}
    </div>
  );
}

/**
 * Shown in real mode while the city has nothing in it (no hosts, databases,
 * buckets, probes or load balancers): tells the user exactly where the file
 * is and offers the one-click import and the resource dialog.
 */
export function EmptyFleet() {
  const dataMode = useFleetStore((store) => store.dataMode);
  const hostCount = useFleetStore((store) => store.hosts.length);
  const resourceCount = useFleetStore((store) => store.resources.length);
  const [hostsFile, setHostsFile] = useState<string | null>(null);
  const { importHosts, importing } = useHostImport();
  // A database, bucket or probe on its own is already a city: don't cover it.
  const visible = dataMode === 'real' && hostCount === 0 && resourceCount === 0;

  useEffect(() => {
    if (!visible) return;
    fetchMeta()
      .then((meta) => setHostsFile(meta.hostsFile ?? null))
      .catch(() => setHostsFile(null));
  }, [visible]);

  if (!visible) return null;
  return (
    <section className="empty-fleet" aria-label="No hosts configured">
      <h2>The city is empty</h2>
      <p>Add your servers and each one becomes a tower of light.</p>
      <ol>
        <li>
          Connect a server step by step (no terminal needed):
          <button
            type="button"
            className="button-primary"
            onClick={() => useUiStore.getState().setAddHostOpen(true)}
          >
            Connect a server
          </button>
        </li>
        <li>
          Or import every host from your SSH config:
          <button
            type="button"
            className="button-primary"
            onClick={importHosts}
            disabled={importing}
          >
            {importing ? 'Importing…' : 'Import from ~/.ssh/config'}
          </button>
        </li>
        <li>
          Or connect a database, bucket, probe or load balancer:
          <button
            type="button"
            className="button-primary"
            onClick={() => useUiStore.getState().setConnectResourceOpen(true)}
          >
            Connect a database or bucket
          </button>
        </li>
        <li>
          Or edit <code>{hostsFile ?? 'hosts.yaml'}</code>. Changes appear live.
        </li>
        <li>
          Hosts must already be in <code>~/.ssh/known_hosts</code>: connect once with{' '}
          <code>ssh</code> and verify the fingerprint.
        </li>
      </ol>
      <p className="empty-fleet-hint">
        Just exploring? Start the server with <code>DATA_MODE=demo</code>.
      </p>
    </section>
  );
}
