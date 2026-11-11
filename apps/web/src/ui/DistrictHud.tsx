import {
  DISTRICT_PROVIDER_LABELS,
  districtHealth,
  isStale,
  RESOURCE_KIND_LABELS,
  type HostStatus,
} from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { durations } from '../design/tokens';
import { StatusDot } from './StatusDot';
import { useNow } from './use-now';
import { useUiStore } from './ui-store';

/**
 * The panel for a focused district: what lives there (servers, databases,
 * buckets, load balancers, probes together), how it is doing as a whole,
 * and what it talks to outside its own borders. Click a member to fly to it.
 */
export function DistrictHud() {
  const name = useUiStore((store) => store.focusedDistrict);
  const focusedHostId = useUiStore((store) => store.focusedHostId);
  const inTerminal = useUiStore((store) => store.terminal !== null);
  const districts = useFleetStore((store) => store.districts);
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const states = useFleetStore((store) => store.states);
  const resourceStates = useFleetStore((store) => store.resourceStates);
  const thresholds = useFleetStore((store) => store.thresholds);
  const links = useFleetStore((store) => store.links);
  const dataMode = useFleetStore((store) => store.dataMode);
  const now = useNow(1000);

  const district = districts.find((d) => d.name === name) ?? (name ? inferred(name) : null);

  const members = useMemo(() => {
    if (!name) return [];
    const list: { id: string; label: string; kind: string; status: HostStatus; stale: boolean }[] =
      [];
    for (const host of hosts) {
      if (host.district !== name) continue;
      const state = states[host.id];
      list.push({
        id: host.id,
        label: host.name,
        kind: 'server',
        status: state?.status ?? 'unknown',
        stale: state ? state.stale || isStale(state.lastSeenAt, now, thresholds) : false,
      });
    }
    for (const resource of resources) {
      if (resource.district !== name) continue;
      const state = resourceStates[resource.id];
      list.push({
        id: resource.id,
        label: resource.name,
        kind: RESOURCE_KIND_LABELS[resource.kind],
        status: state?.status ?? 'unknown',
        stale: state?.stale ?? false,
      });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [name, hosts, resources, states, resourceStates, thresholds, now]);

  const health = districtHealth(members);
  const memberIds = new Set(members.map((m) => m.id));
  const districtOf = (id: string) =>
    hosts.find((h) => h.id === id)?.district ??
    resources.find((r) => r.id === id)?.district ??
    null;
  const outgoing = links.filter((l) => memberIds.has(l.from) && !memberIds.has(l.to));
  const incoming = links.filter((l) => !memberIds.has(l.from) && memberIds.has(l.to));
  const kinds = countBy(members.map((m) => m.kind));

  return (
    <AnimatePresence mode="wait">
      {district && !focusedHostId && !inTerminal && (
        <motion.aside
          key={district.name}
          className={`focus-hud district-hud status-${health.worst}`}
          aria-label={`District ${district.name}`}
          initial={{ opacity: 0, x: 24, scaleY: 0.92 }}
          animate={{ opacity: 1, x: 0, scaleY: 1 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: durations.hudUnfold / 1000, ease: [0.215, 0.61, 0.355, 1] }}
        >
          <header className="hud-header">
            <div>
              <h2>
                <StatusDot status={health.worst} stale={false} /> {district.name}
              </h2>
              <p className="hud-subtitle">
                {district.provider ? DISTRICT_PROVIDER_LABELS[district.provider] : 'district'}
                {district.region ? ` · ${district.region}` : ''}
                {district.inferred && dataMode === 'real' ? ' · describe it in districts.yaml' : ''}
              </p>
            </div>
            <span className="hud-status">{health.worst}</span>
          </header>
          {district.description && <p className="hud-reason">{district.description}</p>}

          <dl className="hud-metrics">
            <Metric label="Buildings" value={String(health.total)} />
            <Metric label="Online" value={String(health.online)} />
            <Metric label="Degraded" value={String(health.degraded)} warn={health.degraded > 0} />
            <Metric label="Offline" value={String(health.offline)} warn={health.offline > 0} />
            <Metric label="Stale" value={String(health.stale)} warn={health.stale > 0} />
            <Metric label="Unknown" value={String(health.unknown)} />
          </dl>
          <p className="hud-muted">
            {Object.entries(kinds)
              .map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`)
              .join(' · ')}
          </p>

          <section className="hud-list" aria-label="Members">
            <h3>Inside</h3>
            <ul>
              {members.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    className="hud-link"
                    onClick={() => useUiStore.getState().focusHost(member.id)}
                  >
                    <StatusDot status={member.status} stale={member.stale} /> {member.label}
                    <small>{member.kind}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {(outgoing.length > 0 || incoming.length > 0) && (
            <section className="hud-list" aria-label="Links to other districts">
              <h3>Across the border</h3>
              <ul>
                {outgoing.map((link) => (
                  <li key={link.id}>
                    <LinkLine from={link.from} to={link.to} where={districtOf(link.to)} arrow="→" />
                  </li>
                ))}
                {incoming.map((link) => (
                  <li key={link.id}>
                    <LinkLine
                      from={link.to}
                      to={link.from}
                      where={districtOf(link.from)}
                      arrow="←"
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <footer className="hud-actions">
            {members.some((m) => m.kind === 'server') && (
              <button
                type="button"
                onClick={() =>
                  useUiStore
                    .getState()
                    .openRunbooks(members.filter((m) => m.kind === 'server').map((m) => m.id))
                }
              >
                Run on these <kbd>R</kbd>
              </button>
            )}
            <button type="button" onClick={() => useUiStore.getState().focusDistrict(null)}>
              Overview <kbd>Esc</kbd>
            </button>
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function LinkLine({
  from,
  to,
  where,
  arrow,
}: {
  from: string;
  to: string;
  where: string | null;
  arrow: string;
}) {
  const focus = useUiStore((store) => store.focusHost);
  return (
    <span className="hud-link-line">
      <button type="button" className="hud-link" onClick={() => focus(from)}>
        {from}
      </button>{' '}
      {arrow}{' '}
      <button type="button" className="hud-link" onClick={() => focus(to)}>
        {to}
      </button>
      {where && <small> in {where}</small>}
    </span>
  );
}

function Metric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="hud-metric">
      <dt>{label}</dt>
      <dd className={warn ? 'is-warning' : undefined}>{value}</dd>
    </div>
  );
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function inferred(name: string) {
  return { id: name, name, provider: null, region: null, description: null, inferred: true };
}
