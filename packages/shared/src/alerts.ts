/**
 * Alert channels: where the server sends "X is offline / degraded / back
 * online" while nobody has the app open. Each channel type is described by
 * its fields, so the Settings form and the server's validation share one
 * definition. Secret fields are saved encrypted and never sent back.
 */

export const ALERT_CHANNEL_TYPES = [
  'email',
  'webhook',
  'ntfy',
  'telegram',
  'teams',
  'pushover',
  'gotify',
  'apprise',
] as const;
export type AlertChannelType = (typeof ALERT_CHANNEL_TYPES)[number];

export interface AlertFieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'secret' | 'number' | 'select' | 'url';
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  default?: string;
}

export interface AlertChannelSpec {
  type: AlertChannelType;
  label: string;
  /** One line under the type picker. */
  hint: string;
  fields: AlertFieldSpec[];
}

export const ALERT_CHANNEL_SPECS: Record<AlertChannelType, AlertChannelSpec> = {
  email: {
    type: 'email',
    label: 'Email (SMTP)',
    hint: 'Any mail server: Gmail or Outlook (app password), SES, Mailgun, Postmark, your own.',
    fields: [
      {
        key: 'host',
        label: 'SMTP server',
        kind: 'text',
        required: true,
        placeholder: 'smtp.gmail.com',
      },
      {
        key: 'security',
        label: 'Security',
        kind: 'select',
        default: 'starttls',
        options: [
          { value: 'starttls', label: 'STARTTLS (port 587)' },
          { value: 'tls', label: 'TLS (port 465)' },
          { value: 'none', label: 'None (port 25, local relays only)' },
        ],
      },
      {
        key: 'port',
        label: 'Port',
        kind: 'number',
        placeholder: '587',
        hint: 'empty: from Security',
      },
      { key: 'user', label: 'User', kind: 'text', placeholder: 'alerts@example.com' },
      { key: 'password', label: 'Password', kind: 'secret', hint: 'for Gmail: an app password' },
      {
        key: 'from',
        label: 'From',
        kind: 'text',
        required: true,
        placeholder: 'GRIDCITY <alerts@example.com>',
      },
      {
        key: 'to',
        label: 'To',
        kind: 'text',
        required: true,
        placeholder: 'ops@example.com, me@example.com',
      },
    ],
  },
  webhook: {
    type: 'webhook',
    label: 'Slack, Discord, Mattermost, Google Chat',
    hint: 'An incoming webhook URL. Any JSON webhook works: it receives text, content and the details.',
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        kind: 'secret',
        required: true,
        placeholder: 'https://hooks.slack.com/services/…',
      },
    ],
  },
  ntfy: {
    type: 'ntfy',
    label: 'ntfy (phone and desktop push)',
    hint: 'Free push to the ntfy app on Android, iPhone and desktop. Pick a hard-to-guess topic.',
    fields: [
      {
        key: 'server',
        label: 'Server',
        kind: 'url',
        default: 'https://ntfy.sh',
        placeholder: 'https://ntfy.sh',
      },
      {
        key: 'topic',
        label: 'Topic',
        kind: 'secret',
        required: true,
        placeholder: 'gridcity-7f3k2q',
      },
      { key: 'token', label: 'Access token', kind: 'secret', hint: 'only for protected topics' },
    ],
  },
  telegram: {
    type: 'telegram',
    label: 'Telegram',
    hint: 'Create a bot with @BotFather, send it a message, then use your chat id (or a group id).',
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        kind: 'secret',
        required: true,
        placeholder: '123456:ABC…',
      },
      {
        key: 'chatId',
        label: 'Chat id',
        kind: 'text',
        required: true,
        placeholder: '123456789 or -100…',
      },
    ],
  },
  teams: {
    type: 'teams',
    label: 'Microsoft Teams',
    hint: 'A Teams Workflows webhook ("Post to a channel when a webhook request is received").',
    fields: [
      {
        key: 'url',
        label: 'Workflow URL',
        kind: 'secret',
        required: true,
        placeholder: 'https://…logic.azure.com/…',
      },
    ],
  },
  pushover: {
    type: 'pushover',
    label: 'Pushover',
    hint: 'Push to the Pushover app. Needs your user key and an application token.',
    fields: [
      { key: 'userKey', label: 'User key', kind: 'secret', required: true },
      { key: 'appToken', label: 'Application token', kind: 'secret', required: true },
    ],
  },
  gotify: {
    type: 'gotify',
    label: 'Gotify (self-hosted push)',
    hint: 'Your own Gotify server and an application token.',
    fields: [
      {
        key: 'server',
        label: 'Server',
        kind: 'url',
        required: true,
        placeholder: 'https://gotify.example.com',
      },
      { key: 'appToken', label: 'Application token', kind: 'secret', required: true },
    ],
  },
  apprise: {
    type: 'apprise',
    label: 'Apprise (100+ services)',
    hint: 'An Apprise API server reaches SMS, WhatsApp, Signal, PagerDuty, Opsgenie and many more.',
    fields: [
      {
        key: 'url',
        label: 'Notify URL',
        kind: 'secret',
        required: true,
        placeholder: 'http://localhost:8000/notify/gridcity',
        hint: '…/notify/<key> for a saved config, or …/notify with Apprise URLs below',
      },
      {
        key: 'urls',
        label: 'Apprise URLs',
        kind: 'secret',
        placeholder: 'tgram://…, mailto://…',
        hint: 'optional',
      },
    ],
  },
};

/** Which transitions a channel hears about. */
export interface AlertEvents {
  offline: boolean;
  degraded: boolean;
  recovered: boolean;
  /** High and critical attacks and exposures, and when they end. */
  security: boolean;
}

export const DEFAULT_ALERT_EVENTS: AlertEvents = {
  offline: true,
  degraded: true,
  recovered: true,
  security: true,
};

/** What the browser sees of a channel: no secret values, only which are set. */
export interface AlertChannelView {
  id: string;
  type: AlertChannelType;
  name: string;
  enabled: boolean;
  events: AlertEvents;
  /** Non-secret settings. */
  settings: Record<string, string>;
  /** Secret fields that have a value saved. */
  secretsSet: string[];
  /** Set by ALERT_WEBHOOK_URL: shown, not editable. */
  fromEnvironment?: boolean;
  lastSentAt: number | null;
  lastError: string | null;
}

/** Create or edit. A secret left out (or empty) on edit keeps the saved value. */
export interface AlertChannelInput {
  type: AlertChannelType;
  name: string;
  enabled: boolean;
  events: AlertEvents;
  settings: Record<string, string>;
}

export interface PushDeviceView {
  /** Short id derived from the endpoint (the endpoint itself is a secret). */
  id: string;
  label: string;
  createdAt: number;
  lastSentAt: number | null;
  lastError: string | null;
}

export interface AlertsView {
  editable: boolean;
  channels: AlertChannelView[];
  push: {
    /** VAPID public key for PushManager.subscribe (null in demo mode). */
    publicKey: string | null;
    devices: PushDeviceView[];
  };
}

/** Problems with a channel's settings, in the words the form shows. */
export function validateAlertChannel(
  input: AlertChannelInput,
  saved: { secretsSet: string[] } | null,
): string[] {
  const spec = ALERT_CHANNEL_SPECS[input.type];
  if (!spec) return [`unknown channel type "${String(input.type)}"`];
  const problems: string[] = [];
  if (!input.name.trim()) problems.push('Name is required.');
  if (input.name.length > 80) problems.push('Name is too long.');
  const known = new Set(spec.fields.map((field) => field.key));
  for (const key of Object.keys(input.settings)) {
    if (!known.has(key)) problems.push(`Unknown setting "${key}".`);
  }
  for (const field of spec.fields) {
    const value = (input.settings[field.key] ?? '').trim();
    const keptSecret = field.kind === 'secret' && saved?.secretsSet.includes(field.key);
    if (field.required && !value && !keptSecret) problems.push(`${field.label} is required.`);
    if (!value) continue;
    if (value.length > 4000) problems.push(`${field.label} is too long.`);
    if (field.kind === 'number' && !/^\d{1,5}$/.test(value)) {
      problems.push(`${field.label} must be a number.`);
    }
    if (field.kind === 'select' && !field.options?.some((option) => option.value === value)) {
      problems.push(
        `${field.label} must be one of ${field.options?.map((o) => o.value).join(', ')}.`,
      );
    }
    const mustBeUrl = field.kind === 'url' || ['url'].includes(field.key);
    if (mustBeUrl && !/^https?:\/\/[^\s]+$/i.test(value)) {
      problems.push(`${field.label} must start with http:// or https://.`);
    }
  }
  if (input.type === 'email') {
    const to = (input.settings.to ?? '').split(',').map((part) => part.trim());
    if (to.some((address) => address && !/^[^\s@<>]+@[^\s@<>]+$/.test(address))) {
      problems.push('To must be email addresses separated by commas.');
    }
  }
  return problems;
}
