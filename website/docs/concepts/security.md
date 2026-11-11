---
title: Security
description: 'What GRIDCITY does with your SSH access, your database credentials and the network.'
---

# Security

GRIDCITY holds powerful access (SSH to your servers, credentials for your databases), so it is
built to be boring about it.

## The network

- It **listens on `127.0.0.1` only**. Binding anything else is refused (inside Docker it binds the
  container's interface and the port is published on the host's `127.0.0.1`).
- Every request needs the **session token** from the printed link (kept in an `HttpOnly`,
  `SameSite=Strict` cookie after the first visit) and a `localhost` Host header (DNS rebinding).
- Every write and WebSocket needs an allowed **Origin** (this machine). The only exception is the
  MCP endpoint called by a local program with the token as a Bearer header.
- `/healthz` is the only route without the token, and it answers `{"ok":true}` and nothing else.
- No CORS, no CDN, no telemetry, no account.

## SSH

- Authentication uses your **ssh-agent**, a key file path, or keys created or uploaded in the app.
  **Private keys and passphrases are never stored** in the database or logs.
- Host keys are checked against `known_hosts` **strictly**. Unknown keys are trusted only after you
  compare the fingerprint; **changed keys are always refused**.
- A password typed in Connect a server is used **once**, in memory, to install your public key, and
  only after the host key is verified.
- One small read-only script per poll; nothing is installed on your servers.

## Database and cloud credentials

- Connectors **only read statistics** (`pg_stat_*` in a read-only session, `SHOW STATUS`, `INFO`,
  `serverStatus`, DMVs, `DescribeDBInstances`, `ListObjectsV2`…), never your rows or objects.
- Passwords, access keys and the alert webhook you paste are stored **encrypted** with AES-256-GCM
  in the local database. The key is a random 32 bytes in `vault.key` next to it (mode 600), or your
  own `SECRETS_KEY`. Config files hold only references (`passwordSecret: orders-db.password`) and
  refuse a `password:` key or a password inside a URL.
- Values never reach logs, the audit log, the browser (only "saved: yes/no") or an AI.
- **Honest limit:** someone who can read your data folder as your user can read the key too, like a
  browser's saved passwords. Back up `vault.key` with the data folder.
- Prefer references? `passwordEnv`, `passwordFile`, environment-named AWS keys and AWS profiles
  still work.

## AI agents

Every command an AI wants to run needs your click. Secrets a command needs on stdin are typed by you
in the app, never shown to the AI. Everything run or denied is in the audit log.

## The Doctor

It proposes; you apply. A fix is re-proven right before it is saved, limited to connection settings,
and audited. Lower-security fixes need a second click with a warning.

## Reporting a vulnerability

Please open a private security advisory on GitHub rather than a public issue.

The full threat model is in [`docs/THREAT_MODEL.md`](https://github.com/chapeee/GRIDCITY/blob/main/docs/THREAT_MODEL.md).
