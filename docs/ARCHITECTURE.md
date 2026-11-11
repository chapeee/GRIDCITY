# Architecture

Status: **v0.1** (all phases of the brief delivered). Sections marked _(Phase N)_ describe planned work.

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
├── config/    env, app paths, hosts.yaml and resources.yaml (zod), ssh config parser + importer
├── connectors/ one file per resource kind behind the Connector interface
├── ssh/       known_hosts verification, auth options, backoff, HostConnection
├── metrics/   collector script, pure parsers (+ real fixtures), rate math
├── fleet/     HostRuntime (pure), RealFleet, DemoFleetProvider, ResourceFleet, StateHub
├── storage/   SQLite migrations, AuditLog, SampleHistory, LayoutStore
├── http/      app + security guard, /ws/state, JSON API
├── security/  bind guard, session token, origin rules
├── cli/       import-ssh-config command
└── testing/   in-process SSH server for end-to-end tests
```

### Config and files

| What             | Default location (from `PROJECT_NAME`, e.g. `example`)                    | Override           |
| ---------------- | ------------------------------------------------------------------------- | ------------------ |
| `hosts.yaml`     | Linux/macOS `~/.config/example/` · Windows `%APPDATA%\example\`           | `CONFIG_DIR`       |
| `resources.yaml` | next to `hosts.yaml`                                                      | `CONFIG_DIR`       |
| `state.db`       | Linux/macOS `~/.local/share/example/` · Windows `%LOCALAPPDATA%\example\` | `DATA_DIR`         |
| `known_hosts`    | `~/.ssh/known_hosts` + system file (read only)                            | `KNOWN_HOSTS_FILE` |
| SSH config       | `~/.ssh/config` (importer only)                                           | `SSH_CONFIG_FILE`  |

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

### Resources beyond SSH (`connectors/`, `fleet/resource-fleet.ts`)

Databases, RDS and S3-compatible storage come from `resources.yaml` (zod, live reload like
`hosts.yaml`; an invalid edit keeps the last valid set and shows the errors). Each kind is one
file returning a `Connector` (`resources()`, `poll()`, `close()`); `connectors/index.ts` is the
only place that knows every kind. Adding a kind = one connector file, one schema in
`resources-file.ts`, one shape mapping in the web app.

| Kind     | Library                                    | Read per poll                                                                                                                                                                                                                               | Default interval |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| postgres | `pg`                                       | `pg_stat_database` (transactions, block hits/reads), `pg_stat_activity` (connections, active > `slowQueryMs`), `max_connections`, `pg_database_size`, replay lag on replicas. Session: `default_transaction_read_only`, `statement_timeout` | 10 s             |
| mysql    | `mysql2`                                   | `SHOW GLOBAL STATUS` (Questions, Threads_connected, Slow_queries, buffer pool), `@@max_connections`, processlist time > limit, `SHOW REPLICA STATUS` (fallback `SLAVE`), `information_schema` size                                          | 10 s             |
| mongodb  | `mongodb`                                  | `serverStatus` (connections, opcounters, WiredTiger cache), `listDatabases` size, `currentOp` > limit, `replSetGetStatus` lag                                                                                                               | 10 s             |
| redis    | `ioredis`                                  | `INFO` (clients, maxclients, commands, hits/misses, memory, role, master link), `SLOWLOG GET 1` (new entries by id)                                                                                                                         | 10 s             |
| mssql    | `mssql`                                    | `dm_os_performance_counters` (batch requests, user connections, buffer cache hit), `dm_exec_requests` > limit, `master_files`, AG lag                                                                                                       | 10 s             |
| sqlite   | `better-sqlite3`                           | opened read-only per poll (no lock held): file and WAL size, page/freelist counts, journal mode, table count                                                                                                                                | 10 s             |
| rds      | `@aws-sdk/client-rds`, `client-cloudwatch` | `DescribeDBInstances` (discovery, status, allocated storage), one `GetMetricData` for CPU, FreeStorageSpace, DatabaseConnections, Read/WriteIOPS, ReplicaLag                                                                                | 60 s             |
| s3       | `@aws-sdk/client-s3`                       | `ListBuckets` (or the configured list), `HeadBucket` latency, paginated `ListObjectsV2` up to `maxObjects`; growth from the last hour of polls                                                                                              | 5 min            |

- **Rates** (ops/s, cache hit) come from counter deltas between polls (`CounterTracker`): unknown
  on the first poll and after a counter reset, never invented. Cache hit is judged only with ≥ 100
  reads in the poll.
- **Discovery:** RDS and S3 entries expand into one resource per instance or bucket
  (`<entry id>-<name>`). When the list changes, the hub re-assigns sticky slots and sends everyone
  a fresh snapshot. If listing fails, the known resources (or one placeholder) go offline with the
  reason.
- **State:** `applyOutcome` / `runtimeToState` (pure) apply the shared rules in
  `packages/shared/src/resource-status.ts`: offline when a poll fails (values become unknown,
  `lastSeenAt` kept), unknown before the first poll, degraded on any broken rule, online
  otherwise. A poll that times out (3 × interval, at least 20 s) changes nothing, so the resource
  goes stale. CloudWatch datapoints older than 5 minutes keep their own time as `lastSeenAt`.
- **Audit:** `resource_reachable` / `resource_unreachable` on transitions only, with the
  scrubbed reason.
- **Secrets:** `readPassword` resolves `passwordEnv` / `passwordFile` at connect time;
  `redactSecrets` scrubs every error before it is logged, audited or sent.
- **Demo:** `packages/shared/src/demo/demo-resources.ts` runs ten demo resources through the real
  rules (a lagging replica, an offline cache, a stale RDS instance, a growing bucket…), served by
  `DemoResourceProvider` or the in-browser demo source.

### Probes and load balancers (`connectors/http.ts`, `tcp.ts`, `loadbalancer.ts`)

| Kind         | Library                                                          | Read per poll                                                                                                                                                                                                  | Default interval |
| ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| http         | `node:http` / `node:https`                                       | One request (GET or HEAD, redirects followed by hand, each hop under the timeout): status, time to first byte, total, body size; plus a TLS handshake for the certificate                                      | 30 s             |
| tcp          | `node:net` / `node:tls`                                          | Connect time, the first banner line if the service speaks first, optional TLS certificate                                                                                                                      | 30 s             |
| loadbalancer | `@aws-sdk/client-elastic-load-balancing-v2`, `client-cloudwatch` | `DescribeLoadBalancers`, `DescribeTargetGroups` + `DescribeTargetHealth`, one `GetMetricData` (RequestCount, TargetResponseTime, ELB/Target 5xx, Target 4xx, ActiveConnectionCount; NLB: flows, resets, bytes) | 60 s             |

`tls-info.ts` reads a certificate with `rejectUnauthorized: false` and reports whether the chain is
trusted and why not, so an expiring self-signed certificate is still visible. Balancer targets are
exposed as `peers()` (address, port, health state) for the topology.

### Service discovery (`metrics/inventory-script.ts`, `parse-inventory.ts`)

A second POSIX script runs on each connected host every `thresholds.discoveryIntervalMs`
(default 30 s): `ss -lntup` (fallback `netstat`), `ss -tn state established`, `ip -o addr`,
`docker ps -a --format …`, `systemctl --failed`, `/var/run/reboot-required`,
`/var/lib/update-notifier/updates-available`. A tool that is missing prints `@@unavailable` and
the parser reports `null` ("could not tell"), never an empty list. The parsed `HostInventory`
(services, own addresses, established connections) lives in `HostRuntime.inventory`; `services`
travels in `HostState` (null while offline), the rest feeds the topology. Fixtures:
`metrics/fixtures/inventory-*.txt`.

### Districts, topology and runbooks (`fleet/topology.ts`, `config/districts-file.ts`, `config/runbooks-file.ts`)

- **Districts:** `districts.yaml` declares provider, region and description; `resolveDistricts`
  (shared) adds an inferred district for every label used by a host or resource. The hub sends
  the list in every snapshot (`districts`).
- **Links:** `computeLinks` (pure, tested) joins `dependsOn` (declared; `balances` when declared
  by a load balancer, `probes` by a probe), established connections matched to another building's
  address + port (observed; a host's own listening ports mark inbound connections, which the other
  side reports), and balancer peers (by IP, or by instance id against a host id or tag). Hostnames
  are resolved with `dns.lookup` every 10 minutes for matching. The hub keeps observed links for
  4 discovery rounds so a missed `ss` does not blink them, and broadcasts a `links` message only
  when the set changes (not when `lastSeenAt` ticks).
- **Runbooks:** `runbooks.yaml` merged with `BUILTIN_RUNBOOKS` (shared; same id replaces a
  built-in). `POST /api/runbooks/run` validates that a runbook applies to every chosen host
  (`match`), then `runOnHosts` runs it over the existing connections, 4 hosts at a time, 64 kB of
  output kept per host. Audit: `runbook_run` / `fleet_command_run` with the command, hosts and
  exit codes (never output).
- **Alerts:** `alerts/webhook.ts` posts `{ text, content, project, target, status, reason… }` to
  `ALERT_WEBHOOK_URL` on every transition into or out of trouble, one message per target per
  minute (offline always), fire and forget; the hub's `onTransition` is the only caller.
  Audit: `alert_sent`.

### State

`HostRuntime` (pure functions) turns connection phases and polls into a `HostState` using the
shared status rules: offline if the connection failed or the heartbeat was lost (current metrics
become unknown, `lastSeenAt` is kept); unknown before the first successful poll; degraded on
sustained CPU, memory or any disk over threshold; online otherwise.

`StateHub` sends each WebSocket client `hello` (protocol version, data mode, thresholds) and a
`snapshot` (hosts, states, layout slots), then `hostStates` containing only hosts whose state
changed. It re-evaluates staleness every second, replays host-key refusals and config errors to
new clients, and swaps the fleet on `hosts.yaml` reload.

### History, Settings and Edit

- `StateHub` records every status change of hosts and resources in `StatusEvents`; `SampleHistory`
  keeps 30 s metric buckets. Both are pruned hourly and whenever the retention changes
  (`AppSettingsStore`, default 7 days). `/api/history` writes the bucket still being filled before
  reading, downsamples to at most 720 points and leaves empty windows as gaps.
- Per-host warning thresholds (`thresholds:` under a host, `HostThresholdOverridesSchema`) are merged
  over the file-wide ones by `thresholdsForHost` in `RealFleet` and in the browser (disk arcs).
- `config/hosts-editor.ts` edits hosts.yaml through the `yaml` Document API (comments kept),
  refuses an invalid file, validates the result before writing, then the fleet reloads.
- With demo data nothing is recorded or saved; History shows generated incidents labelled DEMO DATA
  (`demo/demo-history.ts`).

### Storage (SQLite, `better-sqlite3`)

| Table            | Contents                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_log`      | Append-only (triggers abort UPDATE/DELETE): server start/stop, connection opened/lost/failed, host key refused, hosts imported; terminal sessions in Phase 4. Transitions only, not every retry.                                                                                                                                      |
| `metric_samples` | 30 s buckets (averages; unknown values skipped), 7-day retention (Settings). For the time scrubber later.                                                                                                                                                                                                                             |
| `status_events`  | Status transitions per host or resource (online, degraded, offline; `unknown` is not recorded), real mode only. Incidents are the degraded/offline periods between them. Pruned with the retention, keeping each target's newest event so a long incident keeps its start.                                                            |
| `secrets`        | Credentials pasted in the app (database passwords, access keys, the alert webhook): AES-256-GCM ciphertext, IV and tag per row. The key is `DATA_DIR/vault.key` (created on first start, mode 600) or `SECRETS_KEY`; it is never stored in this database. `resources.yaml` refers to rows by id (`passwordSecret: <entry>.password`). |
| `app_settings`   | JSON app settings from the Settings panel (history retention, 1–90 days, default 7). Never secrets.                                                                                                                                                                                                                                   |
| `layout_slots`   | Sticky slot per host, separate for `real` and `demo`.                                                                                                                                                                                                                                                                                 |

No keys, passphrases or passwords are ever stored.

## WebSocket protocol

Defined in [`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts) (version 2).

- Server → client: `hello`, `snapshot` (hosts, states, layout slots, and since v2 `resources`
  and `resourceStates`), `hostStates` (diff), `resourceStates` (diff), `hostRemoved`,
  `hostKeyRefused`, `error`. Hosts and resources share one slot assignment and ids are unique
  across both (a resource id that clashes with a host is refused).
- Client → server: `ping`, `resync`.
- `dataMode` is fixed per server run (`DATA_MODE=real|demo`). Demo and real data never mix.

### Terminal (`/ws/terminal/:hostId`)

Defined in [`packages/shared/src/terminal-protocol.ts`](../packages/shared/src/terminal-protocol.ts).
The browser sends `{ type: 'open', cols, rows }` (sizes are bounded), then keystrokes as
**binary** frames; `{ type: 'resize' }` on window changes. The server opens a PTY shell
(`xterm-256color`) **on the host's existing SSH connection** (no new handshake), streams output
back as binary frames with simple backpressure, and ends with `exit` (code/signal) or `error`.
If the SSH connection drops, the shell closes and the browser is told. Sessions are audited as
opened/closed with host, size and duration; keystrokes are never recorded.

In the browser, xterm.js (WebGL renderer with DOM fallback, fit add-on) fills the screen once the
dive finishes; the 3D render loop is paused (`frameloop="never"`) while it is open. Every key
goes to the shell, including Esc and Ctrl+K; **Ctrl+Shift+X** (or the header button) returns to
the city, and a clean `exit` returns automatically. A dropped connection or error stays on screen
with "Enter to reconnect". Offline/unknown hosts cannot be entered; demo data says there is no
shell instead of faking one.

### AI agents (`/ws/agent`, `/mcp`)

`apps/server/src/agent/`. Two ways in, one set of rules:

- **MCP** (`mcp-endpoint.ts`, official `@modelcontextprotocol/server` and `/node`): `/mcp` serves
  the 2026 protocol and older stateless HTTP clients, one `McpServer` per request. Tools:
  `list_servers` (read-only summary) and `run_command` (server, command, reason, timeout). Claude
  Code and other MCP apps call it with the session token as a Bearer header; `X-Agent-Client`
  names them on approval cards. `/mcp` is the only path where a Bearer request **without an
  Origin** is accepted (`programPaths` in `create-app.ts`); a browser can't send one.
- **ACP** (`acp-bridge.ts`, official `@agentclientprotocol/sdk`): starts one agent process
  (`agent-catalog.ts`: Codex, Gemini CLI, Claude, as pinned `npx` adapters) over stdio. The
  client offers **no file system and no terminal**, starts it in an empty
  `DATA_DIR/agent-workspace`, and passes the app's `/mcp` endpoint as its only MCP server.
  Permission requests for the fleet tools are allowed (the fleet tools ask the user anyway);
  every other one is refused. Sign-in uses the agent's own methods (`authenticate`); error
  `-32000` at session start (Gemini) or at the first prompt (Codex) shows the sign-in buttons.
- Both call `FleetTools` (`fleet-tools.ts`), which waits on the `ApprovalGate` (`approvals.ts`:
  allow, allow-host until restart, deny; unanswered requests are denied after 5 minutes), runs
  the command with `exec` on the host's existing connection (default timeout 60 s, max 600 s;
  the head and tail of the output are kept), and audits `agent_command_run` or
  `agent_command_denied` (who asked, who allowed, command, exit code).
- `/ws/agent` (`agent-hub.ts`, protocol in `packages/shared/src/agent-protocol.ts`) sends the
  whole agent state (approvals, conversation, running commands, trusted hosts) on every change,
  coalesced; it takes decisions, prompts, start/stop and sign-in. The page keeps it open for the
  whole session so approval cards appear even with the panel closed, and tower labels show
  "AI: <command>" while one runs.

## HTTP API

| Route                                | Purpose                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `GET /api/meta`                      | Project name, version, protocol version                                                                  |
| `GET /ws/state`                      | Live fleet stream (WebSocket)                                                                            |
| `GET /ws/terminal/:hostId`           | Interactive shell (WebSocket)                                                                            |
| `POST /api/hosts`                    | Add one host (draft) to hosts.yaml                                                                       |
| `POST /api/hosts/test`               | Test a draft connection; saves nothing                                                                   |
| `POST /api/hosts/import-ssh-config`  | Import from `~/.ssh/config` into hosts.yaml                                                              |
| `GET /api/audit?limit=200`           | Audit log, newest first                                                                                  |
| `GET /api/ssh/keys`                  | Keys in ssh-agent and the SSH folder (public halves only)                                                |
| `POST /api/ssh/keys`                 | Create a new ed25519 key (409 if the file exists)                                                        |
| `POST /api/ssh/keys/import`          | Upload a private key (.pem/.ppk/OpenSSH); 422 if unusable, 409 if the name is taken                      |
| `POST /api/connect/probe`            | Read a server's host key fingerprint, no login                                                           |
| `POST /api/connect/trust`            | Append a confirmed host key to known_hosts (409 if changed)                                              |
| `POST /api/connect/install`          | Install a public key with the password once (422 if rejected)                                            |
| `GET/POST/DELETE /mcp`               | MCP endpoint for AI apps (Bearer token; no Origin needed)                                                |
| `GET /ws/agent`                      | Approvals and the agent panel (WebSocket)                                                                |
| `POST /api/resources/test`           | One real poll of a draft resource; a password typed for the test lives in that request only              |
| `POST /api/resources`                | `{ resource, secrets }`: credentials go to the vault, the entry (with vault ids) to resources.yaml       |
| `GET /api/resources/:id/credentials` | Which credentials an entry has saved (`password`, `accessKey`: true/false), never values                 |
| `POST /api/alerts/test`              | Send one test message to the saved webhook                                                               |
| `PATCH/DELETE /api/resources/:id`    | Edit name, district, tags of a resources.yaml entry, or remove it                                        |
| `GET /api/history?target=&days=`     | Incidents and chart points (averaged to ≤ 720) for one host/resource, or every incident without `target` |
| `GET/PUT /api/settings`              | Retention and file-wide thresholds (PUT writes hosts.yaml; 409 with demo data)                           |
| `PATCH /api/hosts/:id`               | Edit name, district, tags, own thresholds (hosts.yaml in place; 422 with the problems)                   |
| `DELETE /api/hosts/:id`              | Remove a host from hosts.yaml (its history ages out)                                                     |
| `GET /api/runbooks`                  | Built-in and your own runbooks                                                                           |
| `POST /api/runbooks/run`             | Run a runbook (or a typed command) on chosen servers; one result per server (409 with demo data)         |
| `GET /api/agent/mcp-setup`           | Ready-to-paste Claude Code command and JSON config (contains the token)                                  |

"Connect a server" (`apps/server/src/ssh/host-key-setup.ts`, `local-keys.ts`, `generate-key.ts`)
chains these: probe → trust → pick or create a key → test → install if needed → add. Trust
re-probes and requires the confirmed fingerprint; install verifies the host key strictly before
sending the password. Audit kinds: `host_key_trusted`, `key_created`, `key_installed`, `host_added`.

## Local security

- Binds `127.0.0.1` / `::1` only (`decideBind`). Inside Docker it binds `0.0.0.0` in the
  container and compose publishes on the host's `127.0.0.1` only.
- A random session token is kept in `DATA_DIR/session-token` (mode 600) so the link survives
  restarts (`--new-token` replaces it), and printed (never logged; URLs are redacted in logs).
  After the first visit it is kept in an `HttpOnly; SameSite=Strict` cookie (30 days).
- Key paths written as `~/.ssh/<name>` resolve to `SSH_DIR`, so hosts.yaml works natively and in
  Docker (where `SSH_DIR=/data/ssh` on the persistent volume).
- Jump hosts (`jump:` in hosts.yaml, `ssh/jump.ts`): strict host key check on the bastion, then
  a direct-tcpip tunnel; the server's SSH session (and its host key check) runs end to end over it.
- Cloud images that accept a key for the wrong user only print "Please login as the user X"; the
  connection test runs `echo` and reports `wrong-user` with the suggested user.
- Every request needs a localhost `Host` header (DNS rebinding) and the token.
- WebSocket upgrades and every non-GET request also need an allowed `Origin` (this machine on the
  server or dev port). Upgrades are checked in `preValidation`, as @fastify/websocket requires.
  The one exception is `/mcp` called with a Bearer token and no Origin (a local program).

See [THREAT_MODEL.md](THREAT_MODEL.md).

## Configuration

| Variable                                                        | Default     | Purpose                                                             |
| --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `PROJECT_NAME`                                                  | (required)  | Display name and config/data directory names.                       |
| `DATA_MODE`                                                     | `real`      | `real` (hosts.yaml over SSH) or `demo` (simulated fleet).           |
| `SERVER_PORT`                                                   | `4600`      | API/production port.                                                |
| `WEB_PORT`                                                      | `4601`      | Vite dev server port.                                               |
| `LOG_LEVEL`                                                     | `info`      | Pino log level.                                                     |
| `HOST`                                                          | `127.0.0.1` | Bind address. Non-loopback is refused.                              |
| `BIND_INSIDE_CONTAINER`                                         | `false`     | Set by our Docker image only; allows `0.0.0.0` in-container.        |
| `ALERT_WEBHOOK_URL`                                             | (none)      | Webhook fallback; normally pasted in Settings (stored encrypted).   |
| `SECRETS_KEY`                                                   | (generated) | Base64 32-byte key for the credential vault instead of `vault.key`. |
| `CONFIG_DIR`, `DATA_DIR`, `KNOWN_HOSTS_FILE`, `SSH_CONFIG_FILE` | OS defaults | See "Config and files".                                             |

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
- **Connectors against real instances** (`npm run test:connectors`,
  `compose.connectors-test.yaml`): PostgreSQL 17, MySQL 8.4, MongoDB 8, Redis 7.4 (minimal ACL
  user), MinIO and, with `--mssql`, SQL Server 2022, each with a read-only monitoring user. Checks
  readings and rates, slow-query detection, the read-only session, wrong passwords (never echoed),
  closed ports, a container stopped and started again, bucket growth and the `maxObjects` cap.
  SQLite runs on real files in the normal suite; RDS and CloudWatch use `aws-sdk-client-mock`.
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
├── world/     3D scene (R3F). Pure helpers: host-visuals.ts and resource-visuals.ts
│              (data → light), building-geometry.ts (fixed shapes), city-layout.ts,
│              camera-poses.ts. Components: TowerField, DiskRings, NetworkParticles,
│              WorldLabels, CityFloor, FocusMarker, CameraRig, PostEffects, PerfProbe
├── ui/        2D layer: FocusHud, CommandPalette, overlays, shortcuts, formatters
└── design/    tokens.ts (single source of truth) and CSS variable export
```

- **Data and scene are separate.** Server messages go through the pure `reduceFleet`;
  `useCityModel` turns fleet state into a layout and one `HostVisual` per host.
- **One draw call per layer.** Towers, disk rings and particles are each a single instanced
  mesh (or point cloud) with a custom shader. Each resource shape (drum, prism, caged drum,
  warehouse) is one more instanced mesh using the same material in another shape mode, and all
  RDS cages are one line-segment mesh.
- **WebGL2, not WebGPU (yet).** `postprocessing` and troika only support `WebGLRenderer`.
- **Layout slots** come from the server (`snapshot.layoutSlots`); the in-browser demo source
  assigns them deterministically.
- **Demo URL parameters:** `?hosts=50` (1–200), `?seed=3`, `?poll=500` (ms).
- **Intro** (`IntroOverlay` + `CameraRig`): played once per browser (remembered in local storage,
  skipped with `prefers-reduced-motion`), skippable by any key or click, replayable from the
  palette. It stages nothing: towers light up as real data arrives.
- **Ambient mode** (`use-ambient-director` + pure `ambient-tour.ts`): every 12 s, focus the next
  host that needs attention (offline, degraded, stale; computed from host state, never from
  visuals), or orbit the overview when all is healthy. Manual navigation ends it.
- **Audit log panel:** reads `GET /api/audit`.
- **README media:** `npm run media` records `docs/media/demo.gif` with Playwright on the GPU
  (gifenc, shared 256-color palette).
- **Data source:** by default the browser opens `/ws/state` (through the Vite proxy in
  development). Messages are validated against the shared schema; malformed ones are dropped.
  It reconnects with backoff, and because browsers hide the HTTP status of a failed upgrade, a
  failed connect is followed by a session check so an expired token shows "Session expired"
  instead of retrying forever. `?source=demo` runs the demo fleet in the browser instead.
- **Session in development:** the page is served by Vite, so on load the browser trades the
  `?token=` for the session cookie with one `/api/meta` call, then removes it from the URL.
- **Truth when the link drops:** nothing special is needed: the client re-checks staleness
  every second from `lastSeenAt`, so towers freeze on their own; a banner explains why.
