import { ALERT_CHANNEL_SPECS, type AlertChannelType } from '@app/shared';
import { createTransport } from 'nodemailer';
import { errorMessage, redactSecrets } from '../connectors/connector';

/** What every channel is asked to deliver. */
export interface AlertMessage {
  /** "orders-db is OFFLINE" */
  title: string;
  /** The reason, or "back online (was offline)". */
  body: string;
  /** One line with the project, for chat channels. */
  text: string;
  level: 'offline' | 'degraded' | 'recovered' | 'attack' | 'attack-ended' | 'test';
  project: string;
  /** Structured details for JSON webhooks. */
  details?: Record<string, unknown>;
}

export interface StoredChannel {
  id: string;
  type: AlertChannelType;
  name: string;
  /** Every setting, secrets included (this object only lives in the vault and in memory). */
  settings: Record<string, string>;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailOptions {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  user?: string;
  password?: string;
}

export interface SenderDeps {
  fetch: typeof fetch;
  sendMail: (options: MailOptions, message: MailMessage) => Promise<void>;
  /** Waits between retries (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
}

/** Waits before the second and third attempt when a service fails for a moment. */
export const RETRY_DELAYS_MS = [2_000, 8_000];

/** A failure worth trying again: the service was busy or unreachable, not a refusal. */
class TransientError extends Error {}

const TIMEOUT_MS = 10_000;

export const defaultSenderDeps: SenderDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  sendMail: async (options, message) => {
    const transport = createTransport({
      host: options.host,
      port: options.port,
      secure: options.security === 'tls',
      requireTLS: options.security === 'starttls',
      ignoreTLS: options.security === 'none',
      auth: options.user ? { user: options.user, pass: options.password ?? '' } : undefined,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS * 2,
    });
    try {
      await transport.sendMail(message);
    } finally {
      transport.close();
    }
  },
};

/**
 * Delivers one message to one channel. Throws a readable error, with every
 * secret of the channel removed, when the service refuses or cannot be reached.
 */
export async function sendToChannel(
  channel: StoredChannel,
  message: AlertMessage,
  deps: SenderDeps = defaultSenderDeps,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await deliver(channel, message, deps);
        return;
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isTransient(error)) throw error;
        await sleep(delay);
      }
    }
  } catch (error) {
    const secrets = ALERT_CHANNEL_SPECS[channel.type].fields
      .filter((field) => field.kind === 'secret')
      .map((field) => channel.settings[field.key]);
    throw new Error(redactSecrets(describeFailure(error), secrets), { cause: error });
  }
}

/**
 * Server errors (5xx), rate limits (429), timeouts and network failures are
 * retried; a refusal (bad token, unknown chat, wrong password) is not.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof TransientError) return true;
  const name = (error as { name?: string }).name;
  const message = (error as Error).message ?? '';
  const code = (error as { code?: string }).code ?? '';
  const smtpStatus = (error as { responseCode?: number }).responseCode;
  if (name === 'TimeoutError' || message === 'fetch failed') return true;
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED'].includes(code))
    return true;
  return smtpStatus !== undefined && smtpStatus >= 400 && smtpStatus < 500;
}

function describeFailure(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  const message = errorMessage(error);
  // fetch hides the reason ("fetch failed"); the cause has ENOTFOUND, ECONNREFUSED…
  if (message === 'fetch failed' && cause)
    return `cannot reach the service: ${errorMessage(cause)}`;
  if ((error as Error).name === 'TimeoutError') return 'the service did not answer within 10 s';
  return message;
}

const s = (settings: Record<string, string>, key: string) => (settings[key] ?? '').trim();

async function deliver(channel: StoredChannel, message: AlertMessage, deps: SenderDeps) {
  const settings = channel.settings;
  switch (channel.type) {
    case 'email':
      return sendEmail(settings, message, deps);
    case 'webhook':
      return post(deps, s(settings, 'url'), {
        text: message.text,
        content: message.text,
        project: message.project,
        level: message.level,
        title: message.title,
        body: message.body,
        ...message.details,
        ...(message.level === 'test' ? { test: true } : {}),
      });
    case 'ntfy': {
      const server = (s(settings, 'server') || 'https://ntfy.sh').replace(/\/+$/, '');
      const token = s(settings, 'token');
      return post(
        deps,
        server,
        {
          topic: s(settings, 'topic'),
          title: `${message.project}: ${message.title}`,
          message: message.body || message.title,
          priority: {
            offline: 5,
            degraded: 4,
            recovered: 3,
            attack: 5,
            'attack-ended': 3,
            test: 3,
          }[message.level],
          tags: [
            {
              offline: 'rotating_light',
              degraded: 'warning',
              recovered: 'white_check_mark',
              attack: 'shield',
              'attack-ended': 'white_check_mark',
              test: 'bell',
            }[message.level],
          ],
        },
        token ? { authorization: `Bearer ${token}` } : {},
      );
    }
    case 'telegram': {
      const url = `https://api.telegram.org/bot${s(settings, 'botToken')}/sendMessage`;
      return post(deps, url, {
        chat_id: s(settings, 'chatId'),
        text: message.text,
        disable_web_page_preview: true,
      });
    }
    case 'teams':
      return post(deps, s(settings, 'url'), {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                {
                  type: 'TextBlock',
                  text: `${message.project}: ${message.title}`,
                  weight: 'Bolder',
                  size: 'Medium',
                  wrap: true,
                  color: {
                    offline: 'Attention',
                    degraded: 'Warning',
                    recovered: 'Good',
                    attack: 'Attention',
                    'attack-ended': 'Good',
                    test: 'Default',
                  }[message.level],
                },
                ...(message.body ? [{ type: 'TextBlock', text: message.body, wrap: true }] : []),
              ],
            },
          },
        ],
      });
    case 'pushover': {
      const form = new URLSearchParams({
        token: s(settings, 'appToken'),
        user: s(settings, 'userKey'),
        title: `${message.project}: ${message.title}`,
        message: message.body || message.title,
        priority: message.level === 'offline' || message.level === 'attack' ? '1' : '0',
      });
      return send(deps, 'https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    }
    case 'gotify': {
      const server = s(settings, 'server').replace(/\/+$/, '');
      return post(
        deps,
        `${server}/message`,
        {
          title: `${message.project}: ${message.title}`,
          message: message.body || message.title,
          priority: {
            offline: 8,
            degraded: 5,
            recovered: 2,
            attack: 8,
            'attack-ended': 2,
            test: 4,
          }[message.level],
        },
        { 'x-gotify-key': s(settings, 'appToken') },
      );
    }
    case 'apprise': {
      const urls = s(settings, 'urls');
      return post(deps, s(settings, 'url'), {
        title: `${message.project}: ${message.title}`,
        body: message.body || message.title,
        type: {
          offline: 'failure',
          degraded: 'warning',
          recovered: 'success',
          attack: 'failure',
          'attack-ended': 'success',
          test: 'info',
        }[message.level],
        ...(urls ? { urls } : {}),
      });
    }
  }
}

function post(
  deps: SenderDeps,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  return send(deps, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function send(deps: SenderDeps, url: string, init: RequestInit): Promise<void> {
  const response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.ok) return;
  // Services explain refusals in their body (Telegram: "chat not found").
  const text = (await response.text().catch(() => '')).slice(0, 300);
  let reason = text;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const found =
      json.description ?? json.error ?? json.message ?? json.errors ?? json.errorDescription;
    if (found) reason = typeof found === 'string' ? found : JSON.stringify(found);
  } catch {
    // plain text
  }
  const text2 = `the service answered ${response.status}${reason ? `: ${reason.trim()}` : ''}`;
  throw response.status >= 500 || response.status === 429
    ? new TransientError(text2)
    : new Error(text2);
}

async function sendEmail(
  settings: Record<string, string>,
  message: AlertMessage,
  deps: SenderDeps,
) {
  const security = (s(settings, 'security') || 'starttls') as MailOptions['security'];
  const port = Number(s(settings, 'port')) || { tls: 465, starttls: 587, none: 25 }[security];
  const color = {
    offline: '#e5484d',
    degraded: '#f5a524',
    recovered: '#30a46c',
    attack: '#e5484d',
    'attack-ended': '#30a46c',
    test: '#3e9bff',
  }[message.level];
  const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<p style="margin:0 0 4px;color:#666;font-size:12px;letter-spacing:.08em;text-transform:uppercase">${escape(message.project)}</p>
<h2 style="margin:0 0 8px;border-left:4px solid ${color};padding-left:10px">${escape(message.title)}</h2>
${message.body ? `<p style="margin:0 0 12px">${escape(message.body)}</p>` : ''}
<p style="color:#888;font-size:12px">Sent by GRIDCITY. Open the app and press T to rewind to this moment.</p>
</div>`;
  await deps.sendMail(
    {
      host: s(settings, 'host'),
      port,
      security,
      user: s(settings, 'user') || undefined,
      password: settings.password || undefined,
    },
    {
      from: s(settings, 'from'),
      to: s(settings, 'to'),
      subject: `[${message.project}] ${message.title}`,
      text: `${message.title}\n\n${message.body}\n\nSent by GRIDCITY.`,
      html,
    },
  );
}
