import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useServerLink } from '../data/server-link';
import { useUiStore } from './ui-store';

interface CostReport {
  account: string;
  currency: string;
  monthToDate: number;
  forecast: number | null;
  byService: { service: string; amount: number }[];
  daily: { date: string; amount: number }[];
  updatedAt: number;
  error: string | null;
}

interface CostsView {
  enabled: boolean;
  accounts: string[];
  reports: CostReport[];
}

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount);

/**
 * Cloud costs per AWS account: month to date, the forecast for the month,
 * the services that cost most and the last 30 days. Off until switched on:
 * AWS charges $0.01 per Cost Explorer request.
 */
export function CostsPanel() {
  const open = useUiStore((store) => store.costsOpen);
  const live = useServerLink((link) => link.source === 'server');
  const [view, setView] = useState<CostsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !live) return;
    let cancelled = false;
    fetch('/api/costs', { credentials: 'same-origin' })
      .then((response) => response.json() as Promise<CostsView>)
      .then(
        (loaded) => {
          if (!cancelled) setView(loaded);
        },
        (reason: unknown) => {
          if (!cancelled) setError((reason as Error).message);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [open, live]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/costs', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = (await response.json()) as CostsView & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `failed (${response.status})`);
      setView(body);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="security-panel costs-panel"
          aria-label="Cloud costs"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <header className="audit-header">
            <h2>Cloud costs</h2>
            <div className="audit-actions">
              <button type="button" onClick={() => useUiStore.getState().setCostsOpen(false)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </header>
          {!live && <p className="audit-note">DEMO DATA: there is no AWS account to read.</p>}
          {error && <p className="audit-error">{error}</p>}
          {view && (
            <>
              <div className="alerts-browser">
                <span className={`alerts-dot${view.enabled ? '' : ''}`} aria-hidden />
                <div className="alerts-browser-text">
                  <strong>{view.enabled ? 'Cost tracking is on' : 'Cost tracking is off'}</strong>
                  <span>
                    {view.accounts.length === 0
                      ? 'No AWS account is connected (RDS, a load balancer, or S3 on AWS). Local emulators have no billing.'
                      : `Reads ${view.accounts.join(', ')} from AWS Cost Explorer every 6 hours. AWS charges $0.01 per request: about $2.40 a month.`}
                  </span>
                </div>
                <div className="alerts-actions">
                  <button
                    type="button"
                    className={view.enabled ? undefined : 'button-primary'}
                    disabled={busy || view.accounts.length === 0}
                    onClick={() => void toggle(!view.enabled)}
                  >
                    {busy ? 'Reading…' : view.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                </div>
              </div>
              {view.enabled &&
                view.reports.map((report) => {
                  const max = Math.max(...report.daily.map((d) => d.amount), 0.01);
                  const topMax = Math.max(...report.byService.map((s) => s.amount), 0.01);
                  return (
                    <section key={report.account} className="costs-account">
                      <h3 className="upcoming-heading">{report.account}</h3>
                      {report.error ? (
                        <p className="audit-error">{report.error}</p>
                      ) : (
                        <>
                          <div className="costs-totals">
                            <div>
                              <span>This month so far</span>
                              <strong>{money(report.monthToDate, report.currency)}</strong>
                            </div>
                            <div>
                              <span>Expected for the month</span>
                              <strong>
                                {report.forecast === null
                                  ? '—'
                                  : money(report.forecast, report.currency)}
                              </strong>
                            </div>
                          </div>
                          <div
                            className="costs-daily"
                            role="img"
                            aria-label="Cost per day, last 30 days"
                          >
                            {report.daily.map((day) => (
                              <span
                                key={day.date}
                                className="costs-bar"
                                style={{ height: `${Math.max(2, (day.amount / max) * 100)}%` }}
                                title={`${day.date}: ${money(day.amount, report.currency)}`}
                              />
                            ))}
                          </div>
                          <ul className="costs-services">
                            {report.byService.map((service) => (
                              <li key={service.service}>
                                <span>{service.service}</span>
                                <span className="costs-service-bar">
                                  <i style={{ width: `${(service.amount / topMax) * 100}%` }} />
                                </span>
                                <strong>{money(service.amount, report.currency)}</strong>
                              </li>
                            ))}
                          </ul>
                          <p className="settings-help">
                            Updated {new Date(report.updatedAt).toLocaleString()}.
                          </p>
                        </>
                      )}
                    </section>
                  );
                })}
            </>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
