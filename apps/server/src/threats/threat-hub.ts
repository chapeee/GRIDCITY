import {
  sortFindings,
  type Host,
  type Resource,
  type ThreatCoverage,
  type ThreatFinding,
  type ThreatsView,
  type UpcomingItem,
} from '@app/shared';
import type { AlertCenter } from '../alerts/alert-center';
import type { ResourceConfig } from '../config/resources-file';
import type { AuditLog } from '../storage/audit-log';
import { detectHostThreats, type HostBaseline, type ThreatDraft } from './detect';
import { checkExposure, type ExposureProbes } from './exposure';
import { parseSweepOutput } from './parse-sweep';
import { SWEEP_COMMAND, SWEEP_SCRIPT } from './sweep-script';
import type { ApplyResult, ThreatStore } from './threat-store';

/** Something that can run the sweep on a host: its live SSH connection. */
export interface SweepRunner {
  exec(command: string, stdin: string, timeoutMs: number): Promise<{ stdout: string }>;
}

/** What one producer found for one target in one round. */
export interface ProducerResult {
  targetId: string;
  targetName: string;
  drafts: ThreatDraft[];
  /** Scopes that ran: only they may resolve findings. */
  checkedScopes: string[];
  coverage?: ThreatCoverage['checks'];
  upcoming?: UpcomingItem[];
}

/** A check that runs on its own schedule (certificates, backups, packages, costs…). */
export interface InsightProducer {
  name: string;
  intervalMs: number;
  run(now: number): Promise<ProducerResult[]>;
}

export interface ThreatHubOptions {
  /** Further checks beyond the SSH sweep and exposure (optional). */
  producers?: InsightProducer[];
  store: ThreatStore;
  audit?: AuditLog;
  alerts?: Pick<AlertCenter, 'notifyThreat'>;
  hosts(): readonly Host[];
  /** The connected SSH session for a host, or undefined while it is not connected. */
  runnerFor(hostId: string): SweepRunner | undefined;
  resources(): readonly Resource[];
  /** resources.yaml entries by id (read fresh for each exposure round). */
  resourceConfigs(): Promise<ReadonlyMap<string, ResourceConfig>>;
  probes: ExposureProbes;
  /** Open findings changed: tell every browser. */
  onChange(open: ThreatFinding[]): void;
  retentionDays(): number;
  now?: () => number;
  sweepIntervalMs?: number;
  exposureIntervalMs?: number;
  log?: (message: string) => void;
}

const DAY_MS = 86_400_000;
const SWEEP_TIMEOUT_MS = 30_000;

/**
 * Runs the security checks and keeps the findings: a read-only sweep on
 * every connected server each minute (logins, accounts, ports, CrowdSec,
 * Fail2ban), and exposure checks on resources every ten minutes. New and
 * ended findings go to the audit log, to alert channels (high and critical
 * only) and to every open browser.
 */
export class ThreatHub {
  private readonly coverage = new Map<string, ThreatCoverage>();
  private readonly sweeping = new Set<string>();
  private exposureRunning = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private exposureTimer: ReturnType<typeof setInterval> | null = null;
  private firstRun: ReturnType<typeof setTimeout> | null = null;
  private readonly producerTimers: ReturnType<typeof setInterval>[] = [];
  private readonly producing = new Set<string>();
  /** Latest dated items per producer. */
  private readonly upcomingBy = new Map<string, UpcomingItem[]>();
  private readonly now: () => number;

  constructor(private readonly options: ThreatHubOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.sweepTimer = setInterval(
      () => void this.sweepAll(),
      this.options.sweepIntervalMs ?? 60_000,
    );
    this.exposureTimer = setInterval(
      () => void this.checkExposure(),
      this.options.exposureIntervalMs ?? 10 * 60_000,
    );
    // Give SSH connections a moment to come up before the first round.
    this.firstRun = setTimeout(() => {
      void this.sweepAll();
      void this.checkExposure();
    }, 8_000);
    for (const timer of [this.sweepTimer, this.exposureTimer, this.firstRun]) timer.unref?.();
    for (const producer of this.options.producers ?? []) {
      const timer = setInterval(() => void this.runProducer(producer.name), producer.intervalMs);
      timer.unref?.();
      this.producerTimers.push(timer);
      const first = setTimeout(() => void this.runProducer(producer.name), 12_000);
      first.unref?.();
      this.producerTimers.push(first as unknown as ReturnType<typeof setInterval>);
    }
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.exposureTimer) clearInterval(this.exposureTimer);
    if (this.firstRun) clearTimeout(this.firstRun);
    this.sweepTimer = this.exposureTimer = this.firstRun = null;
    for (const timer of this.producerTimers) clearInterval(timer);
    this.producerTimers.length = 0;
  }

  view(): ThreatsView {
    const since = this.now() - this.options.retentionDays() * DAY_MS;
    const live = this.liveTargets();
    return {
      findings: sortFindings(this.options.store.list(since).filter((f) => live.has(f.targetId))),
      coverage: [...this.coverage.values()].filter((c) => live.has(c.targetId)),
      upcoming: [...this.upcomingBy.values()]
        .flat()
        .filter((item) => live.has(item.targetId))
        .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)),
      demo: false,
    };
  }

  openFindings(): ThreatFinding[] {
    return this.view().findings.filter((finding) => finding.status === 'open');
  }

  /** Findings active during [since, until], for the time travel timeline. */
  between(since: number, until: number): ThreatFinding[] {
    const live = this.liveTargets();
    return this.options.store.between(since, until).filter((f) => live.has(f.targetId));
  }

  async sweepAll(): Promise<void> {
    await Promise.all(this.options.hosts().map((host) => this.sweepHost(host)));
  }

  /** One read-only sweep of one server. */
  async sweepHost(host: Host): Promise<void> {
    const runner = this.options.runnerFor(host.id);
    if (!runner || this.sweeping.has(host.id)) return;
    this.sweeping.add(host.id);
    try {
      const { stdout } = await runner.exec(SWEEP_COMMAND, SWEEP_SCRIPT, SWEEP_TIMEOUT_MS);
      const sweep = parseSweepOutput(stdout, this.now());
      if (!sweep) return;
      const previous = this.options.store.baseline(host.id);
      const detection = detectHostThreats(sweep, previous);
      if (
        !previous &&
        detection.checkedScopes.some((s) => s === 'users' || s === 'listen' || s === 'auth')
      ) {
        this.options.store.saveBaseline(host.id, detection.baseline, this.now());
      }
      this.mergeCoverage(host.id, detection.coverage);
      this.record(host.id, host.name, detection.drafts, detection.checkedScopes);
    } catch (error) {
      this.options.log?.(`security sweep on ${host.name} failed: ${(error as Error).message}`);
    } finally {
      this.sweeping.delete(host.id);
    }
  }

  /** Runs one producer now (or every producer with no name). */
  async runProducer(name?: string): Promise<void> {
    const producers = (this.options.producers ?? []).filter((p) => !name || p.name === name);
    await Promise.all(
      producers.map(async (producer) => {
        if (this.producing.has(producer.name)) return;
        this.producing.add(producer.name);
        try {
          const results = await producer.run(this.now());
          const upcoming: UpcomingItem[] = [];
          for (const result of results) {
            if (result.coverage) this.mergeCoverage(result.targetId, result.coverage);
            upcoming.push(...(result.upcoming ?? []));
            this.record(result.targetId, result.targetName, result.drafts, result.checkedScopes);
          }
          this.upcomingBy.set(producer.name, upcoming);
        } catch (error) {
          this.options.log?.(`${producer.name} checks failed: ${(error as Error).message}`);
        } finally {
          this.producing.delete(producer.name);
        }
      }),
    );
  }

  async checkExposure(): Promise<void> {
    if (this.exposureRunning) return;
    this.exposureRunning = true;
    try {
      const resources = this.options.resources();
      const configs = await this.options.resourceConfigs();
      const results = await checkExposure(resources, configs, this.options.probes, this.now());
      for (const result of results) {
        this.mergeCoverage(result.targetId, result.coverage);
        const name = resources.find((r) => r.id === result.targetId)?.name ?? result.targetId;
        this.record(result.targetId, name, result.drafts, result.checkedScopes);
      }
      this.options.store.prune(
        this.now() - this.options.retentionDays() * DAY_MS,
        this.liveTargets(),
      );
    } catch (error) {
      this.options.log?.(`exposure checks failed: ${(error as Error).message}`);
    } finally {
      this.exposureRunning = false;
    }
  }

  /**
   * "Mark as expected": resolves the finding, and for a new account, port or
   * login address also adds it to the server's baseline so it stays quiet.
   */
  acknowledge(id: string): ThreatFinding | null {
    const finding = this.options.store.acknowledge(id, this.now());
    if (!finding) return null;
    const key = id.slice(finding.targetId.length + 1);
    const baseline = this.options.store.baseline(finding.targetId);
    if (baseline) {
      const learned: HostBaseline = { ...baseline };
      if (key.startsWith('user:')) learned.users = [...baseline.users, `${key.slice(5)}:?`];
      if (key.startsWith('port:')) learned.ports = [...baseline.ports, key.slice(5)];
      if (key.startsWith('new-login:')) learned.logins = [...baseline.logins, key.slice(10)];
      this.options.store.saveBaseline(finding.targetId, learned, this.now());
    }
    this.options.audit?.append('threat_acknowledged', finding.targetId, finding.title);
    this.options.onChange(this.openFindings());
    return finding;
  }

  private record(
    targetId: string,
    name: string,
    drafts: ThreatDraft[],
    checkedScopes: string[],
  ): void {
    const result: ApplyResult = this.options.store.apply(
      targetId,
      drafts,
      checkedScopes,
      this.now(),
    );
    const store = this.options.store;
    const alert = (finding: ThreatFinding, phase: 'opened' | 'escalated' | 'resolved') => {
      const sentTo =
        this.options.alerts?.notifyThreat(finding, phase, name, store.wasAlerted(finding.id)) ?? [];
      if (phase === 'resolved') store.markAlerted(finding.id, false);
      else if (sentTo.length > 0) store.markAlerted(finding.id, true);
    };
    for (const finding of result.opened) {
      this.options.audit?.append(
        'threat_opened',
        targetId,
        `${finding.severity}: ${finding.title}`,
      );
      alert(finding, 'opened');
    }
    for (const finding of result.escalated) {
      this.options.audit?.append(
        'threat_opened',
        targetId,
        `now ${finding.severity}: ${finding.title}`,
      );
      alert(finding, 'escalated');
    }
    for (const finding of result.resolved) {
      this.options.audit?.append('threat_resolved', targetId, finding.title);
      alert(finding, 'resolved');
    }
    if (result.changed) this.options.onChange(this.openFindings());
  }

  /** Replaces the checks with these names on a target and keeps the others. */
  private mergeCoverage(targetId: string, checks: ThreatCoverage['checks']): void {
    const others = (this.coverage.get(targetId)?.checks ?? []).filter(
      (check) => !checks.some((c) => c.name === check.name),
    );
    this.coverage.set(targetId, {
      targetId,
      checkedAt: this.now(),
      checks: [...others, ...checks],
    });
  }

  private liveTargets(): Set<string> {
    return new Set([
      ...this.options.hosts().map((h) => h.id),
      ...this.options.resources().map((r) => r.id),
    ]);
  }
}
