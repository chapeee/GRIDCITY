# Architecture

Status: **draft (Phase 0)**. Sections marked _(Phase N)_ describe planned work.

## Overview

A local-first tool: one Node process on your machine connects **outward** to your servers over
SSH and serves a browser UI on `127.0.0.1`. There is no hosted backend, no telemetry and no
account.

```
 Browser (127.0.0.1)                 Local server (127.0.0.1)                 Your servers
┌──────────────────────┐  HTTP/WS  ┌───────────────────────────┐   SSH    ┌──────────────┐
│ apps/web             │◀────────▶│ apps/server               │────────▶│ sshd          │
│  3D world (R3F)      │  token +  │  connection manager       │ ssh2,    │  /proc, df    │
│  HUD, Cmd+K, xterm   │  Origin   │  metrics poller           │ agent    │  (no agent    │
│  zustand store       │  checks   │  state engine → WS diffs  │          │   installed)  │
└──────────────────────┘           │  terminal (PTY channel)   │          └──────────────┘
                                   │  SQLite: history, layout, │
                                   │          audit log        │
                                   └───────────────────────────┘
          packages/shared: zod schemas + types used by both sides
```

## Packages

| Path              | Name          | Role                                                                 |
| ----------------- | ------------- | -------------------------------------------------------------------- |
| `packages/shared` | `@app/shared` | Zod schemas and TS types: `Host`, `HostState`, thresholds, protocol. |
| `apps/server`     | `@app/server` | Fastify + ws + ssh2 + better-sqlite3. Binds loopback only.           |
| `apps/web`        | `@app/web`    | Vite + React + three/R3F. 3D scene code kept separate from data.     |

Package names are deliberately generic so the project can be renamed by editing `PROJECT_NAME`
only.

## Data flow

1. **Config** _(Phase 2)_ — hosts are read from `hosts.yaml` in the user config directory,
   named after `PROJECT_NAME` (e.g. `~/.config/<project-name>/` or `%APPDATA%\<project-name>\`).
   Validated with zod. Hosts can be imported from `~/.ssh/config`.
2. **Connection manager** _(Phase 2)_ — one persistent ssh2 connection per host, keepalive,
   exponential backoff. Strict `known_hosts`; unknown or changed keys are refused and surfaced.
3. **Metrics poller** _(Phase 2)_ — every `pollIntervalMs`, one compact exec reads
   `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/net/dev`, `/proc/uptime` and
   `df -P -k`. Parsed by pure, fixture-tested functions. CPU and network rates come from deltas.
4. **State engine** _(Phase 2)_ — keeps the latest `HostState` per host, computes status and
   staleness, pushes per-host diffs over WebSocket, stores 48 h of downsampled history in SQLite.
5. **Client** _(Phase 1/3)_ — a single zustand store mirrors server state; the scene reads from it.

## WebSocket protocol

Defined in [`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts).

- Server → client: `hello` (protocol version, data mode), `snapshot`, `hostStates` (diff),
  `hostRemoved`, `hostKeyRefused`, `error`.
- Client → server: `ping`, `resync`.
- `dataMode` is fixed per server run (`real` or `demo`). Demo and real data never mix.

Terminal streaming uses a separate WebSocket per session _(Phase 4)_.

## Local security

- Binds `127.0.0.1` / `::1` only (enforced by `decideBind`). Inside Docker it binds `0.0.0.0`
  in the container and compose publishes on the host's `127.0.0.1` only.
- A random session token is generated on every start and printed (not logged) as part of the URL.
  After the first visit it is kept in an `HttpOnly; SameSite=Strict` cookie scoped by port.
- Every request must present the token and a localhost `Host` header (blocks DNS rebinding).
- WebSocket upgrades will also check `Origin` _(Phase 2)_.

See [THREAT_MODEL.md](THREAT_MODEL.md).

## Configuration

| Variable                | Default     | Purpose                                                      |
| ----------------------- | ----------- | ------------------------------------------------------------ |
| `PROJECT_NAME`          | (required)  | Display name and config directory name.                      |
| `SERVER_PORT`           | `4600`      | API/production port.                                         |
| `WEB_PORT`              | `4601`      | Vite dev server port.                                        |
| `LOG_LEVEL`             | `info`      | Pino log level.                                              |
| `HOST`                  | `127.0.0.1` | Bind address. Non-loopback is refused.                       |
| `BIND_INSIDE_CONTAINER` | `false`     | Set by our Docker image only; allows `0.0.0.0` in-container. |

Real environment variables win over `.env`, which wins over `.env.example`.

## Running

| Mode                   | Command                                     |
| ---------------------- | ------------------------------------------- |
| Docker (users)         | `docker compose up --build`                 |
| Docker dev (reference) | `npm run docker:dev`                        |
| Docker checks          | `npm run docker:test`                       |
| Native dev             | `npm install && npm run dev`                |
| Native production      | `npm install && npm run build && npm start` |

## Docker and SSH _(Phase 2)_

To use your ssh-agent from inside a container, the agent socket must be mounted (Linux:
`$SSH_AUTH_SOCK`; Docker Desktop: `/run/host-services/ssh-auth.sock`) together with a read-only
`known_hosts`. Native runs use the agent directly (Windows: the OpenSSH agent named pipe).
