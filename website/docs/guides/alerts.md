---
title: Alerts
description: 'Desktop notifications and a webhook for Slack, Discord, ntfy or anything that takes JSON.'
---

# Alerts

GRIDCITY tells you when a server or resource **goes offline, turns degraded, or recovers**. The first
status seen after a start is not news; demo data never alerts.

## Desktop notifications

**Settings → Desktop notifications.** The browser asks for permission once. Notifications come from
this browser tab, so keep it open (a pinned tab works).

## Webhook

**Settings → Webhook:** paste the URL and **Save webhook**, then **Send a test**.

| Service    | URL to paste                     |
| ---------- | -------------------------------- |
| Slack      | an Incoming Webhook URL          |
| Discord    | a channel webhook URL            |
| Mattermost | an incoming webhook URL          |
| ntfy       | `https://ntfy.sh/your-topic`     |
| Your own   | any URL that accepts a JSON POST |

The URL is stored encrypted (it contains a token) and never shown again. Each message carries
`text` and `content` (what chat webhooks read) plus structured fields:

```json
{
  "text": "🔴 GRIDCITY: orders-db (PostgreSQL, AWS Mumbai) is OFFLINE — connect ECONNREFUSED",
  "project": "GRIDCITY",
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

A target is reported at most once a minute (offline always), so a flapping server does not flood the
channel. For scripted setups, `ALERT_WEBHOOK_URL` in the environment also works; a webhook saved in
Settings takes precedence.
