# Architecture

Status: **Phase 3** (server and live 3D client wired together). Sections marked _(Phase N)_ describe planned work.

## Overview

A local-first tool: one Node process on your machine connects **outward** to your servers over
SSH and serves a browser UI on `127.0.0.1`. There is no hosted backend, no telemetry and no
account.

```
 Browser (127.0.0.1)                 Local server (127.0.0.1)                 Your servers
┌──────────────────────┐  HTTP/WS  ┌───────────────────────────┐   SSH    ┌──────────────┐
│ apps/web             │◀────────▶│ apps/server               │────────▶│ sshd          │
│  3D world (R3F)      │  token +  │  connection manager       │ ssh2,    │  /proc, df    │
│  HUD, Cmd+K, xterm   │  Origin   │  metrics poller           │ agent    │  (nothing     │
│  zustand store       │  checks   │  state hub → WS diffs     │          │   installed)  │
└──────────────────────┘           │  SQLite: history, layout, │          └──────────────┘
                                   │          audit log        │
                                   └───────────────────────────┘
          packages/shared: zod schemas, status rules, demo fleet, layout slots
```

## Packages

| Path              | Name          | Role                                                                                 |
| ----------------- | ------------- | ------------------------------------------------------------------------------------ |
| `packages/shared` | `@app/shared` | Zod schemas and types, status rules, staleness, sticky layout slots, the demo fleet. |
| `apps/server`     | `@app/server` | Fastify + ws + ssh2 + better-sqlite3. Binds loopback only.                           |
| `apps/web`        | `@app/web`    | Vite + React + three/R3F. 3D scene code kept separate from data.                     |

Package names are deliberately generic so the project can be renamed by editing `PROJECT_NAME`
only.

## Server

```
apps/server/src/
├── config/    env, app paths, hosts.yaml (zod), ssh config parser + importer
├── ssh/       known_hosts verification, auth options, backoff, HostConnection
├── metrics/   collector script, pure parsers (+ real fixtures), rate math
├── fleet/     HostRuntime (pure), RealFleet, DemoFleetProvider, StateHub
├── storage/   SQLite migrations, AuditLog, SampleHistory, LayoutStore
├── http/      app + security guard, /ws/state, JSON API
├── security/  bind guard, session token, origin rules
├── cli/       import-ssh-config command
└── testing/   in-process SSH server for end-to-end tests
```

### Config and files

| What          | Default location (from `PROJECT_NAME`, e.g. `example`)                    | Override           |
| ------------- | ------------------------------------------------------------------------- | ------------------ |
| `hosts.yaml`  | Linux/macOS `~/.config/example/` · Windows `%APPDATA%\example\`           | `CONFIG_DIR`       |
| `state.db`    | Linux/macOS `~/.local/share/example/` · Windows `%LOCALAPPDATA%\example\` | `DATA_DIR`         |
| `known_hosts` | `~/.ssh/known_hosts` + system file (read only)                            | `KNOWN_HOSTS_FILE` |
| SSH config    | `~/.ssh/config` (importer only)                                           | `SSH_CONFIG_FILE`  |

`hosts.yaml` is created with a commented template on first start. The server polls it every 2 s
and **reloads the fleet live**. If an edit makes it invalid, the last valid fleet keeps running
and the errors are pushed to the browser.

**Importing from `~/.ssh/config`** (`npm run import-ssh-config`, or `POST /api/hosts/import-ssh-config`):
concrete `Host` aliases only (no wildcards); `Host` patterns with `*`, `?`, `!`; first value
wins, so `Host *` defaults apply; HostName (`%h`), User, Port, IdentityFile. `Match` and
`Include` are reported as warnings, not followed. Existing ids and `user@address:port`
combinations are skipped, so importing twice is harmless. Comments in `hosts.yaml` are kept.

### Connections

One `HostConnection` per host: keepalive every 5 s (3 missed = heartbeat lost), 10 s handshake
timeout, exponential backoff with jitter (1 s → 60 s). Phases: `connecting`, `connected`,
`failed`; a host stays **offline while reconnecting**.

**Host keys** are checked against `known_hosts` (read only) on every attempt: plain and hashed
entries, `[host]:port`, wildcards and negation, `@revoked`. `@cert-authority` is not supported.
Offered host key algorithms are limited to the types already trusted for that host (as OpenSSH
does), so a server offering a new key type is not mistaken for a changed key. Unknown, changed
or revoked keys are **refused**, reported with their SHA256 fingerprint, audited, and retried
only at the slowest backoff. Nothing ever runs on a host whose key was refused.

**Auth:** `agent` uses `SSH_AUTH_SOCK`, or on Windows the OpenSSH agent pipe
`\\.\pipe\openssh-ssh-agent`. `keyFile` reads the key at connect time; passphrase-protected keys
are refused with advice to use the agent (passphrases are never asked for or stored).

### Metrics

Every `pollIntervalMs`, one exec per connected host runs `sh -s` with the
[collector script](../apps/server/src/metrics/collector-script.ts) on stdin (works with any
login shell, no quoting). Sections are marked; a missing section makes that metric unknown.

| Metric  | Source                        | Rule                                                                                                                                                                                                                                                                               |
| ------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU %   | `/proc/stat` aggregate line   | `1 − Δ(idle+iowait) / Δtotal` between polls; unknown on the first poll and after reboots                                                                                                                                                                                           |
| Memory  | `/proc/meminfo`               | used = MemTotal − MemAvailable (fallback MemFree+Buffers+Cached)                                                                                                                                                                                                                   |
| Swap    | `/proc/meminfo`               | SwapTotal − SwapFree                                                                                                                                                                                                                                                               |
| Load    | `/proc/loadavg`               | 1/5/15 min                                                                                                                                                                                                                                                                         |
| Network | `/proc/net/dev`               | Δbytes / Δt per interface. Skips `lo`, `veth*`, `docker*`, `br-*`, `virbr*`, `cni*`, `flannel*`, `cali*`, `vxlan*` (virtual traffic would be double-counted). Counter resets are dropped for that poll.                                                                            |
| Disks   | `df -P -k`                    | Skips pseudo filesystems, loop devices (snaps), `/proc` `/sys` `/dev` `/run` `/snap`; `overlay` only as `/`; identical size/used/available = one filesystem via bind mounts (shortest path kept). total = used + available (excludes root-reserved blocks, matches df's Capacity). |
| Uptime  | `/proc/uptime`                | seconds                                                                                                                                                                                                                                                                            |
| OS      | `/etc/os-release`, `uname -r` | "PRETTY_NAME · kernel"                                                                                                                                                                                                                                                             |

Parsers are tested against **real captures** from Debian and Alpine (busybox) containers plus a
synthetic Ubuntu VM fixture. A poll that times out (3 × interval) or returns incomplete output
is a **failed poll**: values are kept, nothing is invented, and the host goes **stale**.

### State

`HostRuntime` (pure functions) turns connection phases and polls into a `HostState` using the
shared status rules: offline if the connection failed or the heartbeat was lost (current metrics
become unknown, `lastSeenAt` is kept); unknown before the first successful poll; degraded on
sustained CPU, memory or any disk over threshold; online otherwise.

`StateHub` sends each WebSocket client `hello` (protocol version, data mode, thresholds) and a
`snapshot` (hosts, states, layout slots), then `hostStates` containing only hosts whose state
changed. It re-evaluates staleness every second, replays host-key refusals and config errors to
new clients, and swaps the fleet on `hosts.yaml` reload.

### Storage (SQLite, `better-sqlite3`)

| Table            | Contents                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `audit_log`      | Append-only (triggers abort UPDATE/DELETE): server start/stop, connection opened/lost/failed, host key refused, hosts imported; terminal sessions in Phase 4. Transitions only, not every retry. |
| `metric_samples` | 30 s buckets (averages; unknown values skipped), 48 h retention. For the time scrubber later.                                                                                                    |
| `layout_slots`   | Sticky slot per host, separate for `real` and `demo`.                                                                                                                                            |

No keys, passphrases or passwords are ever stored.

## WebSocket protocol

Defined in [`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts) (version 1).

- Server → client: `hello`, `snapshot`, `hostStates` (diff), `hostRemoved`, `hostKeyRefused`,
  `error`.
- Client → server: `ping`, `resync`.
- `dataMode` is fixed per server run (`DATA_MODE=real|demo`). Demo and real data never mix.

Terminal streaming will use a separate WebSocket per session _(Phase 4)_.

## HTTP API

| Route                               | Purpose                                     |
| ----------------------------------- | ------------------------------------------- |
| `GET /api/meta`                     | Project name, version, protocol version     |
| `GET /ws/state`                     | Live fleet stream (WebSocket)               |
| `POST /api/hosts/import-ssh-config` | Import from `~/.ssh/config` into hosts.yaml |
| `GET /api/audit?limit=200`          | Audit log, newest first                     |

## Local security

- Binds `127.0.0.1` / `::1` only (`decideBind`). Inside Docker it binds `0.0.0.0` in the
  container and compose publishes on the host's `127.0.0.1` only.
- A random session token is generated on every start and printed (never logged; URLs are
  redacted in logs). After the first visit it is kept in an `HttpOnly; SameSite=Strict` cookie.
- Every request needs a localhost `Host` header (DNS rebinding) and the token.
- WebSocket upgrades and every non-GET request also need an allowed `Origin` (this machine on the
  server or dev port). Upgrades are checked in `preValidation`, as @fastify/websocket requires.

See [THREAT_MODEL.md](THREAT_MODEL.md).

## Configuration

| Variable                                                        | Default     | Purpose                                                      |
| --------------------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| `PROJECT_NAME`                                                  | (required)  | Display name and config/data directory names.                |
| `DATA_MODE`                                                     | `real`      | `real` (hosts.yaml over SSH) or `demo` (simulated fleet).    |
| `SERVER_PORT`                                                   | `4600`      | API/production port.                                         |
| `WEB_PORT`                                                      | `4601`      | Vite dev server port.                                        |
| `LOG_LEVEL`                                                     | `info`      | Pino log level.                                              |
| `HOST`                                                          | `127.0.0.1` | Bind address. Non-loopback is refused.                       |
| `BIND_INSIDE_CONTAINER`                                         | `false`     | Set by our Docker image only; allows `0.0.0.0` in-container. |
| `CONFIG_DIR`, `DATA_DIR`, `KNOWN_HOSTS_FILE`, `SSH_CONFIG_FILE` | OS defaults | See "Config and files".                                      |

Real environment variables win over `.env`, which wins over `.env.example`.

## Running

| Mode                   | Command                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Docker (users)         | `docker compose up --build`                                                              |
| Docker with SSH        | `docker compose -f compose.yaml -f compose.ssh.yaml up` (see `compose.ssh.example.yaml`) |
| Docker dev (reference) | `npm run docker:dev`                                                                     |
| Docker checks          | `npm run docker:test` (lint, types, tests, smoke)                                        |
| Native dev             | `npm install && npm run dev`                                                             |
| Native production      | `npm install && npm run build && npm start`                                              |
| Smoke test             | `npm run smoke` (builds and starts the real server)                                      |

**SSH from Docker:** the container needs `known_hosts` (read only) and either your agent socket
(Linux: `$SSH_AUTH_SOCK`; Docker Desktop on macOS: `/run/host-services/ssh-auth.sock`) or, on
Windows, an unencrypted key file, because the Windows OpenSSH agent cannot be forwarded into a
container. `compose.ssh.example.yaml` has all three.

## Testing

- **Unit:** parsers against real fixtures, status rules, runtime, hub, storage, config, SSH
  helpers.
- **End to end over SSH** (`real-fleet.integration.test.ts`): an in-process SSH server checks
  key auth, polling, unknown/changed host key refusal, offline on disconnect and recovery,
  stale when polling is blocked, garbage output, rejected keys and closed ports.
- **HTTP/WS over a real socket:** token, Origin and Host checks, resync, API.
- **Smoke:** the built bundle actually starts and serves (`npm run smoke`).
- **Browser, demo:** Playwright screenshots and interaction tests of the 3D world.
- **Browser, live** (`e2e/live.spec.ts`): the built server against two in-process SSH servers;
  verifies in the UI that killing a connection turns a host offline and back, blocking polling
  freezes it as stale, an unknown host key is refused with its fingerprint, and losing the
  server shows a banner while data freezes.

## Web client

```
apps/web/src/
├── data/      fleet store (zustand) + pure reducer, data-source interface, demo source
├── world/     3D scene (R3F). Pure helpers: host-visuals.ts (data → light), city-layout.ts,
│              camera-poses.ts. Components: TowerField, DiskRings, NetworkParticles,
│              WorldLabels, CityFloor, FocusMarker, CameraRig, PostEffects, PerfProbe
├── ui/        2D layer: FocusHud, CommandPalette, overlays, shortcuts, formatters
└── design/    tokens.ts (single source of truth) and CSS variable export
```

- **Data and scene are separate.** Server messages go through the pure `reduceFleet`;
  `useCityModel` turns fleet state into a layout and one `HostVisual` per host.
- **One draw call per layer.** Towers, disk rings and particles are each a single instanced
  mesh (or point cloud) with a custom shader.
- **WebGL2, not WebGPU (yet).** `postprocessing` and troika only support `WebGLRenderer`.
- **Layout slots** come from the server (`snapshot.layoutSlots`); the in-browser demo source
  assigns them deterministically.
- **Demo URL parameters:** `?hosts=50` (1–200), `?seed=3`, `?poll=500` (ms).
- **Data source:** by default the browser opens `/ws/state` (through the Vite proxy in
  development). Messages are validated against the shared schema; malformed ones are dropped.
  It reconnects with backoff, and because browsers hide the HTTP status of a failed upgrade, a
  failed connect is followed by a session check so an expired token shows "Session expired"
  instead of retrying forever. `?source=demo` runs the demo fleet in the browser instead.
- **Session in development:** the page is served by Vite, so on load the browser trades the
  `?token=` for the session cookie with one `/api/meta` call, then removes it from the URL.
- **Truth when the link drops:** nothing special is needed: the client re-checks staleness
  every second from `lastSeenAt`, so towers freeze on their own; a banner explains why.
