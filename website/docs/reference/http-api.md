---
title: HTTP API
description: "The local server's routes, for scripts and integrations."
---

# HTTP API

Every route needs the session token (cookie, `?token=` on the first page load, or
`Authorization: Bearer`) and a `localhost` Host header. Writes and WebSockets also need an allowed
Origin, except `/mcp` called by a local program with a Bearer token.

| Route                                                 | Purpose                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /healthz`                                        | `{"ok":true}`; the only route without the token                            |
| `GET /api/meta`                                       | name, version, protocol version, data mode                                 |
| `GET /ws/state`                                       | live city stream (WebSocket, protocol v3)                                  |
| `GET /ws/terminal/:hostId`                            | interactive shell (WebSocket)                                              |
| `GET /ws/agent`                                       | approvals and the agent panel (WebSocket)                                  |
| `GET/POST/DELETE /mcp`                                | MCP endpoint for AI apps                                                   |
| `POST /api/hosts`, `POST /api/hosts/test`             | add a server, or test a draft                                              |
| `PATCH/DELETE /api/hosts/:id`                         | edit or remove a server                                                    |
| `POST /api/hosts/import-ssh-config`                   | import from `~/.ssh/config`                                                |
| `POST /api/connect/probe`, `/trust`, `/install`       | the Connect a server steps                                                 |
| `GET/POST /api/ssh/keys`, `POST /api/ssh/keys/import` | list, create, upload keys                                                  |
| `POST /api/resources/test`                            | one real poll of a draft; adds a Doctor report when it fails               |
| `POST /api/resources`                                 | `{ resource, secrets }`: secrets to the vault, the entry to resources.yaml |
| `PATCH/DELETE /api/resources/:id`                     | edit (name, district, tags, new credentials) or remove                     |
| `GET /api/resources/:id/credentials`                  | which credentials are saved (`true`/`false`), never values                 |
| `GET /api/doctor`                                     | machine checks and everything in trouble                                   |
| `POST /api/doctor/resource/:id`                       | full Doctor report for a resource                                          |
| `POST /api/doctor/resource/:id/apply`                 | `{ patch }`: re-prove, then save allow-listed settings                     |
| `POST /api/doctor/host/:id`                           | full Doctor report for a server                                            |
| `GET /api/replay?at=<ms>`                             | the city at a past moment                                                  |
| `GET /api/history?target=&days=`                      | incidents and chart points                                                 |
| `GET/PUT /api/settings`                               | retention, thresholds, webhook (never returned)                            |
| `POST /api/alerts/test`                               | send a test message to the webhook                                         |
| `GET /api/runbooks`, `POST /api/runbooks/run`         | list runbooks; run one (or a command) on chosen servers                    |
| `GET /api/audit?limit=`                               | audit log, newest first                                                    |
| `GET /api/agent/mcp-setup`                            | the Claude Code command and JSON config                                    |

The WebSocket protocol is defined with zod in
[`packages/shared/src/protocol.ts`](https://github.com/chapeee/GRIDCITY/blob/main/packages/shared/src/protocol.ts).
