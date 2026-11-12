import {
  ALERT_CHANNEL_SPECS,
  DEFAULT_ALERT_EVENTS,
  type AlertChannelInput,
  type AlertChannelView,
  type AlertEvents,
  type PushDeviceView,
  type ThreatFinding,
  isMaintenance,
  SEVERITY_RANK,
  validateAlertChannel,
} from '@app/shared';
import { createHash, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import type { SecretStore } from '../storage/secret-vault';
import { describe, type AlertEvent } from './alert-event';
import {
  defaultSenderDeps,
  sendToChannel,
  type AlertMessage,
  type SenderDeps,
  type StoredChannel,
} from './channels';

const CHANNEL_PREFIX = 'alerts.channel.';
const PUSH_PREFIX = 'alerts.push.';
const VAPID_ID = 'alerts.vapid';
/** Before channels existed, Settings saved one webhook here. */
const LEGACY_WEBHOOK_ID = 'alerts.webhook';
/** Findings about activity (they end when it stops); the rest are states that get fixed. */
const ATTACK_CATEGORIES = new Set([
  'brute-force',
  'port-scan',
  'web-attack',
  'suspicious-login',
  'container',
  'cloud',
  'other',
]);
const ENV_CHANNEL_ID = 'env-webhook';
/** A target that keeps flipping in and out of "degraded" alerts at most once in this window. */
const DEFAULT_QUIET_MS = 10 * 60_000;

interface ChannelRecord extends StoredChannel {
  enabled: boolean;
  events: AlertEvents;
  createdAt: number;
}

interface PushRecord {
  id: string;
  label: string;
  createdAt: number;
  subscription: webpush.PushSubscription;
}

interface Delivery {
  lastSentAt: number | null;
  lastError: string | null;
}

export interface WebPushSender {
  send(
    subscription: webpush.PushSubscription,
    payload: string,
    options: webpush.RequestOptions,
  ): Promise<void>;
  generateKeys(): { publicKey: string; privateKey: string };
}

const defaultWebPush: WebPushSender = {
  send: async (subscription, payload, options) => {
    await webpush.sendNotification(subscription, payload, options);
  },
  generateKeys: () => webpush.generateVAPIDKeys(),
};

export interface AlertCenterOptions {
  vault: SecretStore;
  projectName: string;
  /** ALERT_WEBHOOK_URL, shown as a read-only channel. */
  environmentWebhook?: string;
  senders?: SenderDeps;
  webPush?: WebPushSender;
  now?: () => number;
  quietMs?: number;
  log?: (message: string) => void;
}

export class ChannelInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
  }
}

type StatusLevel = 'offline' | 'degraded' | 'recovered';

/**
 * Everything about alerts that happens on the server, so it works while
 * nobody has the app open: the channels (email, chat, push services) and
 * the browsers subscribed to Web Push. Settings live in the encrypted vault.
 */
export class AlertCenter {
  private readonly deliveries = new Map<string, Delivery>();
  /** The last alert sent per target, for flapping protection and closing alerts. */
  private readonly lastAlert = new Map<string, { at: number; level: StatusLevel }>();
  private readonly senders: SenderDeps;
  private readonly webPush: WebPushSender;
  private readonly now: () => number;

  constructor(private readonly options: AlertCenterOptions) {
    this.senders = options.senders ?? defaultSenderDeps;
    this.webPush = options.webPush ?? defaultWebPush;
    this.now = options.now ?? Date.now;
    this.migrateLegacyWebhook();
  }

  // ── channels ──────────────────────────────────────────────────────────

  private records(): ChannelRecord[] {
    const records: ChannelRecord[] = [];
    for (const id of this.options.vault.ids()) {
      if (!id.startsWith(CHANNEL_PREFIX)) continue;
      const raw = this.options.vault.get(id);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw) as ChannelRecord;
        // Channels saved before a kind of event existed hear about it too.
        record.events = { ...DEFAULT_ALERT_EVENTS, ...record.events };
        if (ALERT_CHANNEL_SPECS[record.type]) records.push(record);
      } catch {
        // a damaged entry is skipped, never fatal
      }
    }
    if (this.options.environmentWebhook) {
      records.push({
        id: ENV_CHANNEL_ID,
        type: 'webhook',
        name: 'ALERT_WEBHOOK_URL',
        settings: { url: this.options.environmentWebhook },
        enabled: true,
        events: DEFAULT_ALERT_EVENTS,
        createdAt: 0,
      });
    }
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }

  private record(id: string): ChannelRecord | undefined {
    return this.records().find((record) => record.id === id);
  }

  channels(): AlertChannelView[] {
    return this.records().map((record) => this.view(record));
  }

  hasDestinations(): boolean {
    return this.records().some((record) => record.enabled) || this.devices().length > 0;
  }

  private view(record: ChannelRecord): AlertChannelView {
    const spec = ALERT_CHANNEL_SPECS[record.type];
    const settings: Record<string, string> = {};
    const secretsSet: string[] = [];
    for (const field of spec.fields) {
      const value = record.settings[field.key];
      if (!value) continue;
      if (field.kind === 'secret') secretsSet.push(field.key);
      else settings[field.key] = value;
    }
    const delivery = this.deliveries.get(`channel:${record.id}`);
    return {
      id: record.id,
      type: record.type,
      name: record.name,
      enabled: record.enabled,
      events: record.events,
      settings,
      secretsSet,
      ...(record.id === ENV_CHANNEL_ID ? { fromEnvironment: true } : {}),
      lastSentAt: delivery?.lastSentAt ?? null,
      lastError: delivery?.lastError ?? null,
    };
  }

  /** The record an input describes: saved secrets fill the fields left empty. */
  private merge(input: AlertChannelInput, id: string, saved?: ChannelRecord): ChannelRecord {
    const spec = ALERT_CHANNEL_SPECS[input.type];
    const settings: Record<string, string> = {};
    for (const field of spec.fields) {
      const typed = (input.settings[field.key] ?? '').trim();
      const kept =
        field.kind === 'secret' && saved?.type === input.type ? saved.settings[field.key] : '';
      const value = typed || kept || '';
      if (value) settings[field.key] = value;
    }
    return {
      id,
      type: input.type,
      name: input.name.trim(),
      enabled: input.enabled,
      events: { ...DEFAULT_ALERT_EVENTS, ...input.events },
      settings,
      createdAt: saved?.createdAt ?? this.now(),
    };
  }

  private validate(input: AlertChannelInput, saved?: ChannelRecord) {
    const problems = validateAlertChannel(input, saved ? this.view(saved) : null);
    if (problems.length > 0) throw new ChannelInputError(problems);
  }

  /** Creates (id null) or edits a channel; returns its view. */
  saveChannel(id: string | null, input: AlertChannelInput): AlertChannelView {
    if (id === ENV_CHANNEL_ID)
      throw new ChannelInputError(['This channel comes from ALERT_WEBHOOK_URL.']);
    const saved = id ? this.record(id) : undefined;
    if (id && !saved) throw new ChannelInputError([`No channel "${id}".`]);
    this.validate(input, saved);
    const record = this.merge(input, id ?? `ch-${randomBytes(4).toString('hex')}`, saved);
    this.options.vault.set(CHANNEL_PREFIX + record.id, JSON.stringify(record));
    if (saved && saved.type !== record.type) this.deliveries.delete(`channel:${record.id}`);
    return this.view(record);
  }

  removeChannel(id: string): boolean {
    if (!this.record(id) || id === ENV_CHANNEL_ID) return false;
    this.options.vault.delete(CHANNEL_PREFIX + id);
    this.deliveries.delete(`channel:${id}`);
    return true;
  }

  /** Sends a test through a saved channel, or through a form not saved yet. */
  async testChannel(target: { id: string } | { id?: string | null; input: AlertChannelInput }) {
    let record: ChannelRecord;
    if ('input' in target) {
      const saved = target.id ? this.record(target.id) : undefined;
      this.validate(target.input, saved);
      record = this.merge(target.input, target.id ?? 'draft', saved);
    } else {
      const found = this.record(target.id);
      if (!found) throw new ChannelInputError([`No channel "${target.id}".`]);
      record = found;
    }
    const message = this.testMessage();
    await sendToChannel(record, message, this.senders);
    if (this.record(record.id)) this.track(`channel:${record.id}`, null);
  }

  // ── Web Push ─────────────────────────────────────────────────────────

  private vapid(): { publicKey: string; privateKey: string } {
    const raw = this.options.vault.get(VAPID_ID);
    if (raw) {
      try {
        return JSON.parse(raw) as { publicKey: string; privateKey: string };
      } catch {
        // regenerate below; old subscriptions stop working and are cleaned up on send
      }
    }
    const keys = this.webPush.generateKeys();
    this.options.vault.set(VAPID_ID, JSON.stringify(keys));
    return keys;
  }

  publicKey(): string {
    return this.vapid().publicKey;
  }

  private pushRecords(): PushRecord[] {
    const records: PushRecord[] = [];
    for (const id of this.options.vault.ids()) {
      if (!id.startsWith(PUSH_PREFIX)) continue;
      const raw = this.options.vault.get(id);
      if (!raw) continue;
      try {
        records.push(JSON.parse(raw) as PushRecord);
      } catch {
        // skipped
      }
    }
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }

  devices(): PushDeviceView[] {
    return this.pushRecords().map((record) => {
      const delivery = this.deliveries.get(`push:${record.id}`);
      return {
        id: record.id,
        label: record.label,
        createdAt: record.createdAt,
        lastSentAt: delivery?.lastSentAt ?? null,
        lastError: delivery?.lastError ?? null,
      };
    });
  }

  static deviceId(endpoint: string): string {
    return createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
  }

  subscribe(subscription: webpush.PushSubscription, label: string): PushDeviceView {
    const id = AlertCenter.deviceId(subscription.endpoint);
    const existing = this.pushRecords().find((record) => record.id === id);
    const record: PushRecord = {
      id,
      label: label.trim().slice(0, 80) || 'Browser',
      createdAt: existing?.createdAt ?? this.now(),
      subscription,
    };
    this.options.vault.set(PUSH_PREFIX + id, JSON.stringify(record));
    return this.devices().find((device) => device.id === id)!;
  }

  unsubscribe(id: string): boolean {
    if (!this.pushRecords().some((record) => record.id === id)) return false;
    this.options.vault.delete(PUSH_PREFIX + id);
    this.deliveries.delete(`push:${id}`);
    return true;
  }

  async testDevice(id: string): Promise<void> {
    const record = this.pushRecords().find((candidate) => candidate.id === id);
    if (!record) throw new ChannelInputError(['This browser is not subscribed any more.']);
    await this.push(record, this.testMessage(), 'test', true);
  }

  private async push(record: PushRecord, message: AlertMessage, tag: string, rethrow = false) {
    const keys = this.vapid();
    const payload = JSON.stringify({
      title: `${message.project}: ${message.title}`,
      body: message.body,
      level: message.level,
      tag: `${message.project}:${tag}`,
      url: '/',
    });
    try {
      await this.webPush.send(record.subscription, payload, {
        vapidDetails: {
          subject: 'https://github.com/chapeee/gridcity',
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        TTL: 12 * 3600,
        urgency: message.level === 'offline' || message.level === 'attack' ? 'high' : 'normal',
        timeout: 10_000,
      });
      this.track(`push:${record.id}`, null);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // The browser dropped the subscription (site data cleared, permission revoked).
        this.options.vault.delete(PUSH_PREFIX + record.id);
        this.deliveries.delete(`push:${record.id}`);
        if (rethrow) {
          throw new Error('This browser is not subscribed any more. Turn push on again.', {
            cause: error,
          });
        }
        return;
      }
      const text = status ? `the push service answered ${status}` : (error as Error).message;
      this.track(`push:${record.id}`, text);
      if (rethrow) throw new Error(text, { cause: error });
    }
  }

  // ── dispatch ─────────────────────────────────────────────────────────

  private track(key: string, error: string | null) {
    const previous = this.deliveries.get(key);
    this.deliveries.set(key, {
      lastSentAt: error ? (previous?.lastSentAt ?? null) : this.now(),
      lastError: error,
    });
  }

  private testMessage(): AlertMessage {
    const project = this.options.projectName;
    return {
      title: 'Alerts are connected',
      body: 'You will hear here when something goes offline, degraded, or recovers.',
      text: `✅ ${project}: alerts are connected. You will hear here when something goes offline, degraded, or recovers.`,
      level: 'test',
      project,
    };
  }

  /**
   * A status transition from the fleet. Returns the names of the channels it
   * went to (for the audit log), or an empty list when it does not matter,
   * was just reported (flapping), or nothing is set up.
   */
  notify(event: AlertEvent): string[] {
    const level = levelOf(event);
    if (!level) return [];
    const at = this.now();
    const last = this.lastAlert.get(event.targetId);
    const quiet = this.options.quietMs ?? DEFAULT_QUIET_MS;
    // Offline always goes out. A recovery goes out when it closes an alert that was sent
    // (however soon), never otherwise. Degraded is held back while a target flaps.
    if (level === 'recovered' && (!last || last.level === 'recovered')) return [];
    if (level === 'degraded' && last && at - last.at < quiet) return [];

    const message = messageFor(event, level, this.options.projectName);
    const sentTo = this.dispatch(message, eventKey(level), event.targetId);
    if (sentTo.length > 0) this.lastAlert.set(event.targetId, { at, level });
    return sentTo;
  }

  /**
   * An attack or exposure. Only high and critical findings alert; "attack
   * ended" goes out only for a finding that alerted, so nobody is left
   * believing an attack is still going on.
   */
  notifyThreat(
    finding: ThreatFinding,
    phase: 'opened' | 'escalated' | 'resolved',
    targetName: string,
    /** An alert went out for it before (the threat store keeps this across restarts). */
    alertedBefore = false,
  ): string[] {
    const upkeep = isMaintenance(finding);
    if (phase === 'resolved') {
      if (!alertedBefore) return [];
    } else if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[upkeep ? 'medium' : 'high']) {
      return [];
    }
    const project = this.options.projectName;
    const ended = phase === 'resolved';
    if (upkeep) return this.notifyUpkeep(finding, ended, targetName);
    const where = `${targetName}${finding.attackerIp ? ` · from ${finding.attackerIp}` : ''}`;
    const message: AlertMessage = {
      level: ended ? 'attack-ended' : 'attack',
      project,
      title: ended
        ? `Over: ${finding.title}`
        : `${finding.severity.toUpperCase()}: ${finding.title}`,
      body: ended
        ? ATTACK_CATEGORIES.has(finding.category)
          ? `${where} · no activity since ${new Date(finding.lastSeen).toISOString()}`
          : `${where} · fixed: the latest check no longer finds it`
        : `${where} · ${finding.detail} ${finding.advice}`,
      text: ended
        ? `✅ ${project}: attack over on ${targetName}: ${finding.title}`
        : `🛡️ ${project}: ${finding.severity.toUpperCase()} on ${targetName}: ${finding.title}. ${finding.detail}`,
      details: {
        target: finding.targetId,
        name: targetName,
        severity: finding.severity,
        category: finding.category,
        source: finding.source,
        attackerIp: finding.attackerIp,
        count: finding.count,
        blocked: finding.blocked,
        status: ended ? 'resolved' : 'open',
        at: new Date(
          ended ? (finding.resolvedAt ?? finding.lastSeen) : finding.lastSeen,
        ).toISOString(),
      },
    };
    const sentTo = this.dispatch(message, 'security', `threat:${finding.id}`);
    return sentTo;
  }

  /**
   * Upkeep (certificate or domain expiry, disk filling up, late backup, cost
   * spike): a warning on the channels that hear about "degraded", and a
   * "resolved" message when it is dealt with.
   */
  private notifyUpkeep(finding: ThreatFinding, ended: boolean, targetName: string): string[] {
    const project = this.options.projectName;
    const urgent = finding.severity === 'critical';
    const message: AlertMessage = {
      level: ended ? 'recovered' : urgent ? 'offline' : 'degraded',
      project,
      title: ended ? `Resolved: ${finding.title}` : finding.title,
      body: ended
        ? `${targetName} · the latest check no longer finds it`
        : `${targetName} · ${finding.detail} ${finding.advice}`,
      text: ended
        ? `🟢 ${project}: resolved on ${targetName}: ${finding.title}`
        : `${urgent ? '🔴' : '🟡'} ${project}: ${targetName}: ${finding.title}. ${finding.detail}`,
      details: {
        target: finding.targetId,
        name: targetName,
        severity: finding.severity,
        category: finding.category,
        status: ended ? 'resolved' : 'open',
        at: new Date(
          ended ? (finding.resolvedAt ?? finding.lastSeen) : finding.lastSeen,
        ).toISOString(),
      },
    };
    return this.dispatch(message, ended ? 'recovered' : 'degraded', `upkeep:${finding.id}`);
  }

  private dispatch(message: AlertMessage, wants: keyof AlertEvents, tag: string): string[] {
    const sentTo: string[] = [];
    for (const record of this.records()) {
      if (!record.enabled || !record.events[wants]) continue;
      sentTo.push(record.name);
      void sendToChannel(record, message, this.senders).then(
        () => this.track(`channel:${record.id}`, null),
        (error: Error) => {
          const previous = this.deliveries.get(`channel:${record.id}`)?.lastError;
          this.track(`channel:${record.id}`, error.message);
          if (previous !== error.message)
            this.options.log?.(`alert to ${record.name} failed: ${error.message}`);
        },
      );
    }
    const devices = this.pushRecords();
    for (const device of devices) void this.push(device, message, tag);
    if (devices.length > 0)
      sentTo.push(devices.length === 1 ? '1 browser' : `${devices.length} browsers`);
    return sentTo;
  }

  private migrateLegacyWebhook() {
    const url = this.options.vault.get(LEGACY_WEBHOOK_ID);
    if (!url) return;
    if (!this.options.vault.has(`${CHANNEL_PREFIX}webhook`)) {
      const record: ChannelRecord = {
        id: 'webhook',
        type: 'webhook',
        name: 'Webhook',
        settings: { url },
        enabled: true,
        events: DEFAULT_ALERT_EVENTS,
        createdAt: this.now(),
      };
      this.options.vault.set(`${CHANNEL_PREFIX}webhook`, JSON.stringify(record));
    }
    this.options.vault.delete(LEGACY_WEBHOOK_ID);
  }
}

function levelOf(event: AlertEvent): StatusLevel | null {
  if (event.to === 'offline') return 'offline';
  if (event.to === 'degraded') return 'degraded';
  if (event.to === 'online' && (event.from === 'offline' || event.from === 'degraded')) {
    return 'recovered';
  }
  return null;
}

const eventKey = (level: StatusLevel): keyof AlertEvents => level;

function messageFor(event: AlertEvent, level: StatusLevel, project: string): AlertMessage {
  const title =
    level === 'offline'
      ? `${event.targetName} is OFFLINE`
      : level === 'degraded'
        ? `${event.targetName} is degraded`
        : `${event.targetName} is back online`;
  const where = `${event.kind} · ${event.district}`;
  const body =
    level === 'recovered'
      ? `${where} · was ${event.from}`
      : `${where}${event.reason ? ` · ${event.reason}` : ''}`;
  return {
    title,
    body,
    text: describe(event, project),
    level,
    project,
    details: {
      target: event.targetId,
      name: event.targetName,
      kind: event.kind,
      district: event.district,
      from: event.from,
      status: event.to,
      reason: event.reason,
      at: new Date(event.at).toISOString(),
    },
  };
}
