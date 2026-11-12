import { validateAlertChannel, type AlertChannelInput } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '../storage/secret-vault';
import { AlertCenter, ChannelInputError, type WebPushSender } from './alert-center';
import type { AlertEvent } from './alert-event';
import { sendToChannel, type AlertMessage, type SenderDeps } from './channels';

function memoryVault(): SecretStore {
  const values = new Map<string, string>();
  return {
    get: (id) => values.get(id),
    has: (id) => values.has(id),
    set: (id, value) => void values.set(id, value),
    delete: (id) => void values.delete(id),
    deletePrefix: (prefix) => {
      for (const id of [...values.keys()]) if (id.startsWith(prefix)) values.delete(id);
    },
    ids: () => [...values.keys()].sort(),
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeSenders(status: number | number[] = 200, body = '{}') {
  const statuses = Array.isArray(status) ? [...status] : null;
  const calls: Call[] = [];
  const mails: Parameters<SenderDeps['sendMail']>[] = [];
  const deps: SenderDeps = {
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(body, {
        status: statuses ? (statuses.shift() ?? 200) : (status as number),
      });
    }) as unknown as typeof fetch,
    sendMail: vi.fn(async (...args: Parameters<SenderDeps['sendMail']>) => {
      mails.push(args);
    }),
    sleep: async () => undefined,
  };
  return { deps, calls, mails };
}

const message: AlertMessage = {
  title: 'orders-db is OFFLINE',
  body: 'PostgreSQL · Databases · ECONNREFUSED',
  text: '🔴 City: orders-db (PostgreSQL, Databases) is OFFLINE — ECONNREFUSED',
  level: 'offline',
  project: 'City',
};

const json = (call: Call) => JSON.parse(String(call.init.body)) as Record<string, unknown>;

describe('alert channels', () => {
  it('sends each service the payload it reads', async () => {
    const { deps, calls } = fakeSenders();
    await sendToChannel(
      { id: 'a', type: 'webhook', name: 'Slack', settings: { url: 'https://hooks.example/x' } },
      message,
      deps,
    );
    expect(json(calls[0]!)).toMatchObject({
      text: message.text,
      content: message.text,
      level: 'offline',
    });

    await sendToChannel(
      { id: 'b', type: 'ntfy', name: 'ntfy', settings: { topic: 'gc-123', token: 'tk' } },
      message,
      deps,
    );
    expect(calls[1]!.url).toBe('https://ntfy.sh');
    expect(json(calls[1]!)).toMatchObject({
      topic: 'gc-123',
      priority: 5,
      title: 'City: orders-db is OFFLINE',
    });
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tk');

    await sendToChannel(
      { id: 'c', type: 'telegram', name: 'TG', settings: { botToken: '1:AB', chatId: '42' } },
      message,
      deps,
    );
    expect(calls[2]!.url).toBe('https://api.telegram.org/bot1:AB/sendMessage');
    expect(json(calls[2]!)).toMatchObject({ chat_id: '42', text: message.text });

    await sendToChannel(
      {
        id: 'd',
        type: 'gotify',
        name: 'G',
        settings: { server: 'https://g.example/', appToken: 'gt' },
      },
      message,
      deps,
    );
    expect(calls[3]!.url).toBe('https://g.example/message');
    expect(json(calls[3]!)).toMatchObject({ priority: 8 });

    await sendToChannel(
      { id: 'e', type: 'pushover', name: 'P', settings: { appToken: 'at', userKey: 'uk' } },
      message,
      deps,
    );
    expect(String(calls[4]!.init.body)).toContain('priority=1');

    await sendToChannel(
      { id: 'f', type: 'teams', name: 'T', settings: { url: 'https://x.logic.azure.com/w' } },
      message,
      deps,
    );
    expect(JSON.stringify(json(calls[5]!))).toContain('AdaptiveCard');

    await sendToChannel(
      {
        id: 'g',
        type: 'apprise',
        name: 'A',
        settings: { url: 'http://apprise:8000/notify', urls: 'tgram://x' },
      },
      message,
      deps,
    );
    expect(json(calls[6]!)).toMatchObject({ type: 'failure', urls: 'tgram://x' });
  });

  it('sends email over SMTP with the port the security implies', async () => {
    const { deps, mails } = fakeSenders();
    await sendToChannel(
      {
        id: 'm',
        type: 'email',
        name: 'Mail',
        settings: {
          host: 'smtp.example.com',
          security: 'tls',
          user: 'u',
          password: 'pw',
          from: 'a@example.com',
          to: 'b@example.com',
        },
      },
      message,
      deps,
    );
    const [options, mail] = mails[0]!;
    expect(options).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      security: 'tls',
      user: 'u',
      password: 'pw',
    });
    expect(mail.subject).toBe('[City] orders-db is OFFLINE');
    expect(mail.html).toContain('ECONNREFUSED');
  });

  it('explains refusals without leaking the channel secrets', async () => {
    const { deps } = fakeSenders(
      400,
      JSON.stringify({ description: 'Bad Request: chat not found 1:SECRET' }),
    );
    await expect(
      sendToChannel(
        { id: 'c', type: 'telegram', name: 'TG', settings: { botToken: '1:SECRET', chatId: '42' } },
        message,
        deps,
      ),
    ).rejects.toThrow('the service answered 400: Bad Request: chat not found ***');
  });

  it('tries again when a service is busy, but not when it refuses', async () => {
    const busy = fakeSenders([500, 503, 200]);
    await sendToChannel(
      { id: 'n', type: 'ntfy', name: 'ntfy', settings: { topic: 't' } },
      message,
      busy.deps,
    );
    expect(busy.calls).toHaveLength(3);

    const refused = fakeSenders([401, 200], JSON.stringify({ error: 'unauthorized' }));
    await expect(
      sendToChannel(
        { id: 'n', type: 'ntfy', name: 'ntfy', settings: { topic: 't' } },
        message,
        refused.deps,
      ),
    ).rejects.toThrow('the service answered 401: unauthorized');
    expect(refused.calls).toHaveLength(1);

    const down = fakeSenders([502, 502, 502, 200]);
    await expect(
      sendToChannel(
        { id: 'n', type: 'ntfy', name: 'ntfy', settings: { topic: 't' } },
        message,
        down.deps,
      ),
    ).rejects.toThrow('502');
    expect(down.calls).toHaveLength(3);
  });

  it('validates the form with the same rules as the browser', () => {
    const input: AlertChannelInput = {
      type: 'email',
      name: 'Ops',
      enabled: true,
      events: { offline: true, degraded: true, recovered: true, security: true },
      settings: { host: 'smtp.example.com', from: 'a@example.com', to: 'not an address' },
    };
    expect(validateAlertChannel(input, null)).toEqual([
      'To must be email addresses separated by commas.',
    ]);
    expect(validateAlertChannel({ ...input, type: 'webhook', settings: {} }, null)).toEqual([
      'Webhook URL is required.',
    ]);
    // An edit may leave a saved secret empty.
    expect(
      validateAlertChannel({ ...input, type: 'webhook', settings: {} }, { secretsSet: ['url'] }),
    ).toEqual([]);
  });
});

const event = (
  to: AlertEvent['to'],
  from: AlertEvent['from'] = 'online',
  targetId = 'pg',
): AlertEvent => ({
  targetId,
  targetName: 'orders-db',
  kind: 'PostgreSQL',
  district: 'Databases',
  from,
  to,
  reason: to === 'offline' ? 'ECONNREFUSED' : null,
  at: 0,
});

function fakeWebPush() {
  const sent: { endpoint: string; payload: string }[] = [];
  let failWith: number | null = null;
  const sender: WebPushSender = {
    send: async (subscription, payload) => {
      if (failWith) throw Object.assign(new Error('push failed'), { statusCode: failWith });
      sent.push({ endpoint: subscription.endpoint, payload });
    },
    generateKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
  };
  return { sender, sent, fail: (status: number | null) => (failWith = status) };
}

const subscription = (n: number) => ({
  endpoint: `https://push.example/${n}`,
  keys: { p256dh: 'p', auth: 'a' },
});

describe('alert center', () => {
  const setup = (now = { t: 1_000 }) => {
    const vault = memoryVault();
    const senders = fakeSenders();
    const push = fakeWebPush();
    const center = new AlertCenter({
      vault,
      projectName: 'City',
      senders: senders.deps,
      webPush: push.sender,
      now: () => now.t,
    });
    return { vault, senders, push, center, now };
  };

  const webhook = (name = 'Slack'): AlertChannelInput => ({
    type: 'webhook',
    name,
    enabled: true,
    events: { offline: true, degraded: false, recovered: true, security: false },
    settings: { url: 'https://hooks.example/secret-token' },
  });

  it('keeps secrets in the vault and never in the view', () => {
    const { center, vault } = setup();
    const saved = center.saveChannel(null, webhook());
    expect(saved.secretsSet).toEqual(['url']);
    expect(JSON.stringify(center.channels())).not.toContain('secret-token');
    expect(vault.ids().some((id) => id.startsWith('alerts.channel.'))).toBe(true);
    // Editing without retyping the URL keeps it.
    center.saveChannel(saved.id, { ...webhook('Renamed'), settings: { url: '' } });
    expect(JSON.parse(vault.get(`alerts.channel.${saved.id}`)!).settings.url).toBe(
      'https://hooks.example/secret-token',
    );
    expect(() => center.saveChannel(null, { ...webhook(), settings: {} })).toThrow(
      ChannelInputError,
    );
  });

  it('sends transitions to the channels that want them and to every browser', async () => {
    const { center, senders, push } = setup();
    center.saveChannel(null, webhook());
    center.subscribe(subscription(1), 'Chrome on Windows');
    expect(center.notify(event('offline'))).toEqual(['Slack', '1 browser']);
    await vi.waitFor(() => expect(senders.calls).toHaveLength(1));
    expect(push.sent).toHaveLength(1);
    expect(JSON.parse(push.sent[0]!.payload)).toMatchObject({
      title: 'City: orders-db is OFFLINE',
      level: 'offline',
    });
    // This channel does not want "degraded"; browsers still get it.
    expect(center.notify(event('degraded', 'online', 'other'))).toEqual(['1 browser']);
    // Unknown → online is not news.
    expect(center.notify(event('online', null, 'third'))).toEqual([]);
  });

  it('always closes a sent alert, holds back degraded flapping, never holds offline', () => {
    const { center, now } = setup();
    center.saveChannel(null, {
      ...webhook(),
      events: { offline: true, degraded: true, recovered: true, security: true },
    });
    expect(center.notify(event('offline'))).toHaveLength(1);
    now.t += 10_000;
    // Back online 10 s later: still reported, or people think it is down.
    expect(center.notify(event('online', 'offline'))).toHaveLength(1);
    now.t += 5_000;
    expect(center.notify(event('degraded'))).toEqual([]); // flapping
    expect(center.notify(event('online', 'degraded'))).toEqual([]); // nothing open to close
    expect(center.notify(event('offline', 'online'))).toHaveLength(1);
    now.t += 10 * 60_000 + 1000;
    expect(center.notify(event('degraded', 'offline'))).toHaveLength(1);
  });

  it('drops browsers the push service says are gone', async () => {
    const { center, push } = setup();
    const device = center.subscribe(subscription(2), 'Edge');
    push.fail(410);
    await expect(center.testDevice(device.id)).rejects.toThrow(/not subscribed any more/);
    expect(center.devices()).toEqual([]);
  });

  it('records the last error of a channel for Settings', async () => {
    const vault = memoryVault();
    const failing = fakeSenders(500, 'boom');
    const center = new AlertCenter({
      vault,
      projectName: 'City',
      senders: failing.deps,
      webPush: fakeWebPush().sender,
    });
    const saved = center.saveChannel(null, webhook());
    center.notify(event('offline'));
    await vi.waitFor(() =>
      expect(center.channels()[0]!.lastError).toBe('the service answered 500: boom'),
    );
    await expect(center.testChannel({ id: saved.id })).rejects.toThrow('500');
  });

  it('tests a form before it is saved, and moves the old webhook setting over', async () => {
    const vault = memoryVault();
    vault.set('alerts.webhook', 'https://hooks.example/legacy');
    const senders = fakeSenders();
    const center = new AlertCenter({
      vault,
      projectName: 'City',
      senders: senders.deps,
      webPush: fakeWebPush().sender,
    });
    expect(center.channels().map((channel) => channel.name)).toEqual(['Webhook']);
    expect(vault.has('alerts.webhook')).toBe(false);
    await center.testChannel({ input: webhook('Draft') });
    expect(json(senders.calls[0]!)).toMatchObject({ level: 'test', test: true });
    expect(center.channels()).toHaveLength(1);
  });

  it('shows ALERT_WEBHOOK_URL as a read-only channel', () => {
    const center = new AlertCenter({
      vault: memoryVault(),
      projectName: 'City',
      environmentWebhook: 'https://hooks.example/env',
      senders: fakeSenders().deps,
      webPush: fakeWebPush().sender,
    });
    expect(center.channels()[0]).toMatchObject({
      id: 'env-webhook',
      fromEnvironment: true,
      secretsSet: ['url'],
    });
    expect(() => center.saveChannel('env-webhook', webhook())).toThrow(ChannelInputError);
  });
});

describe('attack alerts', () => {
  const threat = (
    severity: 'medium' | 'high' | 'critical',
    status: 'open' | 'resolved' = 'open',
  ) => ({
    id: 'web-1:brute-force:203.0.113.9',
    targetId: 'web-1',
    source: 'crowdsec' as const,
    severity,
    category: 'brute-force' as const,
    title: 'SSH brute force from 203.0.113.9',
    detail: '150 failed SSH logins in the last hour.',
    advice: 'Use SSH keys only.',
    attackerIp: '203.0.113.9',
    count: 150,
    firstSeen: 0,
    lastSeen: 1000,
    blocked: false,
    status,
    resolvedAt: status === 'resolved' ? 2000 : null,
  });

  it('alerts on high and critical attacks only, and reports the end of one it alerted', async () => {
    const vault = memoryVault();
    const senders = fakeSenders();
    const center = new AlertCenter({
      vault,
      projectName: 'City',
      senders: senders.deps,
      webPush: fakeWebPush().sender,
    });
    center.saveChannel(null, {
      type: 'webhook',
      name: 'Slack',
      enabled: true,
      events: { offline: true, degraded: true, recovered: true, security: true },
      settings: { url: 'https://hooks.example/x' },
    });
    expect(center.notifyThreat(threat('medium'), 'opened', 'web-1')).toEqual([]);
    expect(center.notifyThreat(threat('medium', 'resolved'), 'resolved', 'web-1', false)).toEqual(
      [],
    );
    expect(center.notifyThreat(threat('high'), 'opened', 'web-1')).toEqual(['Slack']);
    await vi.waitFor(() => expect(senders.calls).toHaveLength(1));
    expect(json(senders.calls[0]!)).toMatchObject({
      level: 'attack',
      title: 'HIGH: SSH brute force from 203.0.113.9',
      attackerIp: '203.0.113.9',
    });
    expect(center.notifyThreat(threat('high', 'resolved'), 'resolved', 'web-1', true)).toEqual([
      'Slack',
    ]);
    await vi.waitFor(() => expect(senders.calls).toHaveLength(2));
    expect(json(senders.calls[1]!)).toMatchObject({ level: 'attack-ended', status: 'resolved' });
  });

  it('respects a channel that turned attacks off, and gives old channels attacks by default', () => {
    const vault = memoryVault();
    // A channel saved before attack alerts existed (no "security" key).
    vault.set(
      'alerts.channel.old',
      JSON.stringify({
        id: 'old',
        type: 'webhook',
        name: 'Old',
        settings: { url: 'https://h.example/o' },
        enabled: true,
        events: { offline: true, degraded: true, recovered: true },
        createdAt: 1,
      }),
    );
    const center = new AlertCenter({
      vault,
      projectName: 'City',
      senders: fakeSenders().deps,
      webPush: fakeWebPush().sender,
    });
    center.saveChannel(null, {
      type: 'webhook',
      name: 'Quiet',
      enabled: true,
      events: { offline: true, degraded: true, recovered: true, security: false },
      settings: { url: 'https://h.example/q' },
    });
    expect(center.notifyThreat(threat('critical'), 'opened', 'web-1')).toEqual(['Old']);
  });
});
