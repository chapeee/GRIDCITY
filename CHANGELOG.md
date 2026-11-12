# Changelog

## Unreleased

### Manage: every database, Redis and bucket becomes a workspace

- Focus a building and press **M** (or **Ctrl+K → Manage …**). Read-only until you click
  **Allow changes…**; read-only is enforced by the server and the database itself (read-only or
  rolled-back transactions, read-only SQLite files, Redis's own write flags), and every change is
  written to the audit log.
- **One SQL manager for PostgreSQL, MySQL/MariaDB, SQL Server and SQLite**: schema tree, rows with
  paging, sort and search, inline editing, insert and delete by primary key (never more than one
  row), structure, relationships both ways, DDL, and a query editor with schema completion,
  Explain and history. Results stop at 1000 rows without loading the rest.
- **Redis**: SCAN-based key browser with an editor per type, TTL and rename, a console that asks
  before dangerous commands, timed MONITOR recording, slow log, command stats, clients, INFO.
- **MongoDB**: find with Extended JSON filters, edit, insert and delete documents, aggregation,
  indexes, running operations.
- **Object storage** (S3, Spaces, MinIO, R2, LocalStack): browse, upload with progress and drag
  and drop, download, delete, copy and move, tags, previews, bucket policy, CORS, versioning, ACL,
  encryption, usage per folder.
- `compose.tools.yaml`: Adminer, CloudBeaver and Redis Commander next to GRIDCITY, for deep
  administration (localhost only, nothing to configure).

### Fixes found while testing against LocalStack, Moto and real databases

- AWS RDS and load balancers accept an API endpoint (VPC endpoints, LocalStack, Moto).
- A load balancer without target groups is no longer shown as degraded.
- MongoDB and SQL Server no longer report their own background work as slow queries.
- TCP probes read banners of binary protocols (MySQL greets with "8.4.13 …", not "J").
- The Doctor explains HTTP status/body mismatches, TCP banner mismatches and "signed in, but
  nothing to watch", and a proven fix that sets a setting without a form field (Mongo
  `authSource`) now applies.
- A server restart behind a proxy no longer shows "Session expired"; the agent socket stops
  retrying a dead session.
- The empty-city card no longer covers databases and buckets, and offers to connect one.
- Forms keep what you typed when you click outside them; the test result scrolls into view; the
  Docker "localhost" hint appears only when the app runs in a container.
- The command palette ranks actions above loosely matching runbooks.

## 0.2.0 · 2026-11-11

The first public release, on npm (`npx gridcity`) and as a Docker image
(`ghcr.io/chapeee/gridcity`).

### The Doctor

- A failed connection gets a diagnosis instead of a raw error. The Doctor climbs a connection
  ladder (DNS, port, TLS, login), matches the real error texts of every driver against 30 rules,
  recognises managed providers (DigitalOcean, RDS, Azure, Supabase, Neon, PlanetScale, Upstash,
  Atlas, Aiven) and **tries each proposed fix with a real read-only connection before offering
  it**. A fix that gets further but hits a new problem is followed one more step.
- In the connect dialog, both HUDs (D), a Doctor panel (this machine, likely root causes,
  everything in trouble), and headless: `gridcity doctor [--json]` for CI and agents.
- Typing a managed host sets TLS and the right port before the first attempt.
- Database TLS: verify the certificate (on by default) and paste a provider's CA certificate.

### Time travel

- T rewinds the whole city to any moment in the recorded history and plays it back; incidents
  are marked on the timeline. Clearly labelled REPLAY, never mixed with live data.

### Topology, blast radius, root cause

- Links between buildings from declared `dependsOn`, connections observed on the servers, and
  load balancer targets. Each panel shows the blast radius; when failures cascade, a banner names
  the likely root cause.

### Districts that hold anything

- A district holds servers, databases, buckets, load balancers and probes together, described in
  `districts.yaml` (provider, region).

### New kinds

- HTTP and TCP probes (status, latency, certificate expiry) drawn as beacons.
- AWS Application and Network Load Balancers (state, target health, traffic) drawn as gates.

### Servers

- Service discovery over SSH: listening ports, Docker containers, failed systemd units, pending
  (security) updates, reboot-required, open connections.
- Runbooks and fleet-wide commands (R): saved or typed commands on servers picked by district or
  tag, one result row per server. Built-in read-only diagnostics.

### Everything in the app

- Database passwords, access keys and the alert webhook are pasted in the app and stored
  encrypted (AES-256-GCM, local key). No `.env` editing.
- Alerts: desktop notifications, and a webhook (Slack, Discord, ntfy) set in Settings with a test
  button.

### AI agents

- New MCP tools: `incident_report` (root causes and blast radius in one call), `diagnose` (the
  Doctor, with proven fixes), `get_topology`, `list_runbooks`. Commands that never hang an AI
  client (`wait_for_command`), approval cards with a note for the AI and an answer for sudo.
- `gridcity mcp` prints the command to connect Claude Code.

### Distribution

- `npx gridcity` / `npm i -g gridcity`: `gridcity`, `gridcity demo`, `gridcity doctor`,
  `gridcity mcp`, `--port`, `--open`.
- Docker image with a health check, volumes for config and data, `host.docker.internal` mapped,
  and `compose.image.yaml` to run it without cloning.

### Camera

- Drag moves across the city at the same zoom; right-drag orbits; arrow keys pan.

## 0.1.0

- The city of light: live SSH metrics, real terminals, databases, RDS and buckets, AI agents
  with approval, history, settings and edit.
