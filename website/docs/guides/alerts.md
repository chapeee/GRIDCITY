---
title: Alerts
description: 'Push notifications, email, Slack, Discord, Telegram, Teams, ntfy, Pushover, Gotify and Apprise, sent by the server even when nobody has the app open.'
---

# Alerts

GRIDCITY tells you when a server or resource **goes offline, turns degraded, or recovers**. Alerts
are sent **by the server**, the moment the fleet sees the change, so they arrive whether or not
anyone is signed in or has a tab open. The first status seen after a start is not news; demo data
never alerts. Every alert is also kept in history: press **T** to rewind to the moment it happened.

Everything is set in **Settings → Alerts**, and saved encrypted on this machine. You never edit a
file or an environment variable.

## Browser notifications (Web Push)

**Settings → Alerts → Browser notifications → Turn on.** The browser asks for permission once, and a
test notification arrives right away. From then on, alerts show up as Windows, macOS or Android
notifications **even with the GRIDCITY tab closed**, as long as the browser runs (Chrome, Edge and
Firefox keep running in the background). Turn it on in each browser you use; the list shows every
subscribed browser and lets you remove old ones.

Offline alerts stay on screen until you look at them. Clicking one opens GRIDCITY.

Web Push needs a secure page: `http://localhost`, `http://127.0.0.1` or `https://`. If you open
GRIDCITY over plain `http://` on a network address, the setting explains this and offers
notifications while the tab is open instead.

## Channels

**+ Add channel**, pick a type, fill in the form, **Send a test**, then **Save channel**. You can try a
channel before saving it. Each channel chooses which changes it hears about (offline, degraded,
recovered, and [attacks](./security.md)), and can be paused, edited, tested or removed. The list shows when each one last
delivered and the last error, if any.

| Channel                                     | What you need                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Email (SMTP)**                            | any SMTP server: Gmail or Outlook with an app password, SES, Mailgun, Postmark, your own relay                           |
| **Slack, Discord, Mattermost, Google Chat** | an incoming webhook URL (any JSON webhook works)                                                                         |
| **ntfy**                                    | a topic (free push to the ntfy app on Android, iPhone and desktop), on ntfy.sh or your own server                        |
| **Telegram**                                | a bot token from @BotFather and your chat id                                                                             |
| **Microsoft Teams**                         | a Workflows webhook ("Post to a channel when a webhook request is received")                                             |
| **Pushover**                                | your user key and an application token                                                                                   |
| **Gotify**                                  | your Gotify server and an application token                                                                              |
| **Apprise**                                 | an [Apprise API](https://github.com/caronc/apprise-api) server: SMS, WhatsApp, Signal, PagerDuty, Opsgenie and 100+ more |

### Email settings

| Security | Port | Use it for                           |
| -------- | ---- | ------------------------------------ |
| STARTTLS | 587  | most providers (Gmail, Outlook, SES) |
| TLS      | 465  | providers that ask for "SSL"         |
| None     | 25   | a relay on your own network only     |

For Gmail, turn on 2-step verification and create an **app password**; your normal password will be
refused.

### Webhook payload

Webhooks receive `text` and `content` (what chat webhooks read) plus structured fields:

```json
{
  "text": "🔴 GRIDCITY: orders-db (PostgreSQL, AWS Mumbai) is OFFLINE — connect ECONNREFUSED",
  "content": "…the same text…",
  "project": "GRIDCITY",
  "level": "offline",
  "title": "orders-db is OFFLINE",
  "body": "PostgreSQL · AWS Mumbai · connect ECONNREFUSED",
  "target": "orders-db",
  "name": "orders-db",
  "kind": "PostgreSQL",
  "district": "AWS Mumbai",
  "from": "online",
  "status": "offline",
  "reason": "connect ECONNREFUSED",
  "at": "2026-11-11T03:12:09.000Z"
}
```

## No floods, no silent recoveries

- **Offline** is always sent.
- **Back online** is always sent when it closes an alert that went out, however soon after. You are
  never left believing something is still down.
- **Degraded** is held back for ten minutes after the last alert for the same target, so a server
  flapping around a threshold does not flood your channels.

## Scripted setups

`ALERT_WEBHOOK_URL` in the environment adds a webhook channel, shown in Settings as read-only. A
webhook saved in Settings before this version moves into the channel list automatically.
