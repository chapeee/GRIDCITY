# Changelog

## 1.0.0 · 2026-11-14

**GRIDCITY 1.0: what the README promises now works**, checked end to end against LocalStack,
Moto, real databases, an attack lab, Mailpit and ntfy, plus a security pass that attacked the
app. Updating from any earlier version keeps all your data: the config files, the database and
the data folders are unchanged, and the first start saves a copy first.

- **Updates keep your data, with a copy.** On the first start of a new version, the database,
  vault key, link and settings are copied to `backups/` in the data folder before anything
  uses them, and never deleted. A database whose format would change is never touched without
  that copy. Tested by updating real installs of 0.3.0, 0.4.3 and 0.5.0 (npm) and the 0.5.0
  desktop app, full of data: every row, saved password, alert secret, setting and the link
  survived. On macOS/Linux, data that XDG variables kept in another folder is copied over.
- **Opening GRIDCITY without its key shows a page**, not an error in JSON: it explains why and
  takes the link. Browsers keep the key for 400 days, renewed on every visit; the key itself
  never changes unless you ask (`--new-token`).

- **Certificates about to expire turn probes amber.** An HTTP or TCP probe whose certificate
  expires within 14 days (`certificateDegradedDays`) now shows as degraded, as documented. The
  expiry was measured but never reached the status rule.
- **One broken entry no longer hides every resource.** When an entry in `resources.yaml` is
  wrong, only that entry is skipped (marked "not loaded" in the banner, at startup and by
  `gridcity doctor`); every other database, bucket and probe keeps running, and you can still
  edit, add or turn on changes for them.
- **RDS and load balancers accept `accessKeyIdEnv` / `secretAccessKeyEnv`**, like buckets. They
  were refused, although the docs and the error message suggest them.
- **"Block public access" clears the public bucket finding.** With all four settings on, a public
  policy no longer applies to the public, so the finding is resolved instead of staying open.
- **One side panel at a time.** Opening Security, Upcoming, Logs, Costs, the Doctor, History,
  Settings or the audit log closes the one that was in the same place, so Esc closes the panel
  you see instead of one hidden under it.
- **AI approval cards stay clear.** The "rendering is slow" hint steps aside while an AI command
  waits for your click, so no other button sits next to Allow; "Add a note for the AI…" puts
  the cursor in the note.
- **"Password for this test" is used.** With the password taken from a variable or a file, the
  Connect dialog offers a password for the test, but ignored it, so the test failed with
  "environment variable … is not set". It is now used for that one test and never saved.
- A backup that is too small shows as "this week" in Upcoming, with the reason, not "this month".
- No Node.js warning about TLS server names when a probe checks an IP address.
- **Adding or editing several things at once keeps all of them.** Two changes to `hosts.yaml` or
  `resources.yaml` at the same moment (two tabs, a quick double add, an import while editing) could
  lose one, although both said "added", or corrupt the file so that nothing loaded after a
  restart. Changes now go one at a time and the file is replaced in one step.
- Esc closes Search logs (L) while the cursor is in its search box.

Security, from a second pass that attacked the app:

- **Read-only Redis no longer runs scripts that write.** `EVAL`, `EVALSHA` and `FCALL` could call
  any command (a `SET`, a `FLUSHALL`) while changes were off. They now need Changes on;
  `EVAL_RO` and friends still work, enforced by Redis. `PUBLISH` (it reaches your applications)
  needs Changes on too, and `MULTI` no longer leaves the console stuck in a transaction.
- **Read-only SQL refuses functions that act on the server**: `pg_terminate_backend` (it killed
  other sessions), `pg_reload_conf`, advisory locks, large-object file exports, MySQL `GET_LOCK`,
  SQLite `load_extension`, also when hidden behind comments or quotes.
- **AI approval cards show exactly what runs.** Invisible and right-to-left characters, which
  can make a command read differently from what it does, are shown as ⟨U+…⟩ with a warning, and
  such a command always asks, even with "Allow all". Long commands say how many lines to read,
  and a long run of spaces can no longer push the end out of view.
- **"Allow all" still asks for hidden code**: `curl … | sh`, `base64 -d | sh`, `eval`,
  interpreter one-liners that delete, recursive ownership changes of system folders, and moving
  SSH or system configuration away.
- Several AI requests at once scroll inside their stack; none can end up off screen.
- A login after failed attempts says when its address is blocked, and stays critical: the
  password still works from anywhere else.
- AI agents read sizes as `20 GiB`, not `21474836480 bytes`.

## 0.5.0 · 2026-11-14

- **Desktop app for Windows, macOS and Linux**, with Chromium built in and no Node.js needed.
  Download the `.exe`, `.dmg`, `.AppImage`, `.deb` or `.rpm` from the GitHub release, or run
  `npx gridcity-desktop`. It runs the same server as the `gridcity` command and shares its data.
  Closing the window keeps it in the tray, still monitoring. The tray can switch to the demo
  city, open GRIDCITY in your browser, or stop it.
- **Start at login**: the installed app starts with the computer, hidden in the tray, so
  monitoring and alerts survive a restart. On by default; a tray checkbox turns it off.
- Every GitHub release lists the installers and `SHA256SUMS.txt` as downloads.
- Manifests for winget, Scoop, Homebrew and the AUR (`packaging/distribution/`).
- **Runbooks say what they found.** "Pending updates" is now "List pending updates": its output
  opens on its own, read-only runs say they changed nothing, and a list of packages no longer
  reads as "all succeeded" or fails with a false exit 1.

## 0.4.3 · 2026-11-13

- **Starts on Windows with Smart App Control / Application Control.** These block
  better-sqlite3's unsigned native file, and `gridcity start` stopped with "The SQLite driver
  (better-sqlite3) could not be loaded". GRIDCITY now falls back to the SQLite built into
  Node.js 22.16 or newer, so there is nothing extra to load and nothing to block. Your data and
  saved credentials stay where they were. The log says
  `using the SQLite built into Node.js` when this happens.
- **`npm i -g gridcity` no longer fails on Windows with Node 22** when Visual Studio is not
  installed. npm 10 tried to compile better-sqlite3. It is now an optional dependency, and when
  npm leaves it out GRIDCITY uses the built-in SQLite.
- `GRIDCITY_SQLITE_DRIVER=node` or `better-sqlite3` picks the SQLite driver.
- CI runs every test with both SQLite drivers on Linux, macOS and Windows, on Node 22.16 and 24.

## 0.4.2 · 2026-11-12

- **Live demo on GitHub Pages**: <https://chapeee.github.io/GRIDCITY/demo/> runs the simulated
  city in the browser, with no install and no server. GitHub and Install buttons point visitors to
  the repo and to `npx gridcity`. It is linked from the README and the docs (navbar, home page,
  quick start). The Docs workflow builds it (`STATIC_DEMO=true npm run build:demo -w @app/web`).
- **A bigger demo city**: three new districts (GCP Frankfurt, Azure London, Oracle Hyderabad), for
  eight in all, with 13 more servers, an Azure SQL database, a Cloud SQL database, Memorystore, two
  more buckets, an Azure load balancer and their links. The online demo shows 96 hosts.
- The AI agent panel says agents need the app when it runs in the in-browser demo, instead of
  waiting on "Connecting to the app…" forever.
- **The Doctor works in the demo**: diagnosing a demo building shows a simulated report (the
  DNS / port / TLS / login checks, the cause with its evidence, and fixes with commands); applying
  a proven fix is simulated. Also in `gridcity demo`.
- **Security and Upcoming in the in-browser demo**: simulated attacks and exposures (with red rings
  on the buildings) and upcoming certificate, disk, backup and domain dates, all labelled DEMO DATA.
- **Ctrl+K picks the best match across all groups.** An exact action or resource ("settings",
  "session-cache") no longer loses to a fuzzy server match.
- The npm package carries `mcpName` (`io.github.chapeee/gridcity`), and `server.json` describes
  it for the official [MCP Registry](https://registry.modelcontextprotocol.io).

## 0.4.1 · 2026-11-12

- **`gridcity` keeps running after you close the terminal.** `gridcity` and `gridcity demo`
  start the server in the background and print the link; new commands `gridcity status`,
  `gridcity stop`, `gridcity restart` and `gridcity logs [-f]`. `--foreground` keeps the old
  behaviour, for systemd, launchd, Task Scheduler and containers (the Docker image is unchanged).
- The background log (`server.log` in the data folder) never contains the session token.

## 0.4.0 · 2026-11-12

The same app as 0.3.0, released as 0.4.0: no functional changes. Everything listed under
0.3.0 below is in it.

## 0.3.0 · 2026-11-12

The first release on npm (`npx gridcity`).

### Upcoming, fixes and investigation

- **Upcoming panel (U)**: certificates and domains that expire (RDAP via IANA's directory),
  disks that will fill up (trend since the last cleanup), and backups that are late, missing or too
  small (a file pattern over SSH or a bucket prefix). Alerts 30, 7 and 1 days ahead.
- **Vulnerable packages**: every server's packages checked against OSV.dev every 12 hours; one
  finding per server with the fixable ones first, scored by CVSS 3.1.
- **One-click fixes** from findings: block an attacker (Fail2ban, CrowdSec or iptables), lock an
  account, block public access on a bucket. Each shows the exact command, needs a second click,
  runs through `sudo -n`, is audited and re-checked at once.
- **Runbooks for findings**, and three new read-only ones: recent logins and failures, accounts
  with power, CrowdSec and Fail2ban status.
- **What happened**: the incident timeline around any moment (status, findings, commands, AI
  actions, changes, alerts), from a finding or time travel.
- **Log search (L)** across every server's journal, /var/log files and container logs at once.
- **Containers and Kubernetes**: crash loops, OOM kills, unhealthy containers and pods in
  trouble become findings; the HUD shows CPU, memory and restarts per container.
- **Cloud costs (C)**: month to date, forecast, top services and 30 days per AWS account, with
  alerts on spikes; off until turned on (Cost Explorer charges per request).
- Fix: a probe flapping around "degraded" no longer sends an alert every minute (10-minute
  window).

### Security: see who is attacking what

- **Attacks and exposures on the buildings**: a pulsing red ring around anything under a high or
  critical attack, an amber ring for medium ones, a shield in the toolbar with the count, and a
  Security panel (**S**) with every finding worst first: what was seen, the attacker's address, how
  many times, whether it is blocked, and what to do. A security section in each building's HUD,
  attack bars in time travel, and `security_findings` for AI agents.
- **Readable from across the city**: an attack strikes down the building from the roof and a ring
  spreads from its base; "Show building" flies there and lights the building up for a moment.
- **SSH server** is the first choice in the Connect dialog.
- **Built-in checks over the existing SSH connection, read-only and with nothing to install**: SSH
  brute force, a login right after failed attempts (a guessed password), logins from new addresses,
  a second root account, new accounts, new open ports and refused sudo. The first check learns what
  is normal; **Mark as expected** teaches it more.
- **CrowdSec and Fail2ban**: what they caught appears on the building; the same attacker seen by
  several detectors is one finding, "blocked" only when something enforces it (a CrowdSec ban
  without a bouncer is reported as not blocked). Reading them through `sudo -n` for just those
  two commands.
- **Exposures**: public buckets (policy or ACL), buckets without a public access block, RDS
  databases open to the internet (public and a security group open to 0.0.0.0/0), Redis and
  MongoDB that need no password.
- **Alerts**: high and critical findings go to every channel with "Attacks" on, and an "Over:"
  message follows when they end, even across restarts. Every channel now retries a delivery that
  failed for a moment (server error, rate limit, timeout).
- **Attack lab** (`compose.security-lab.yaml`, `node scripts/security-lab.mjs`): a Debian SSH
  server with CrowdSec and Fail2ban and two attackers on a private network, running real brute
  force, password guessing, backdoor accounts and a new port, plus exposures on LocalStack and Moto.
- Licensing: CrowdSec, Fail2ban and the rest are used only through their own commands and APIs; no
  code of theirs is included.

### Alerts that reach you with the app closed

- **Browser notifications by Web Push**: turn them on once per browser and alerts arrive as
  Windows, macOS or Android notifications even with the GRIDCITY tab closed. Offline alerts stay on
  screen; clicking one opens the city.
- **Alert channels**: email over any SMTP server, Slack, Discord, Mattermost, Google Chat,
  Telegram, Microsoft Teams, ntfy, Pushover, Gotify, and Apprise for 100+ more. Each channel picks
  offline, degraded and recovered, can be tested before saving, paused or removed, and shows when it
  last delivered and its last error. Settings are encrypted in the vault; secrets never come back.
- The old single webhook moves into the channel list; `ALERT_WEBHOOK_URL` shows as a read-only
  channel.
- Fix: a "back online" alert that came within a minute of the offline alert was dropped, leaving
  people to believe the service was still down. A recovery now always closes a sent alert.
- The app has an icon (browser tab and notifications).

### Easier to find your way

- A toolbar at the top right opens Connect, the Doctor, time travel, history, runbooks, the audit
  log, the AI agent and Settings with one click (the keys still work), with tooltips naming each
  shortcut. Opening a panel there closes the other side panels instead of stacking them.
- A bell shows whether alerts reach anyone while the app is closed; an amber dot means none do.
- Next to the project name, a fleet pulse counts what is online, degraded, offline and unknown;
  click it to open the Doctor.
- Building names stay readable in crowded districts: outlined, never hidden behind the building in
  front, and long names shortened in the middle.

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

The first public release, as a Docker image (`ghcr.io/chapeee/gridcity`); the npm package
followed with 0.3.0.

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
