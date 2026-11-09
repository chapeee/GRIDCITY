# Project brief

The original product brief, kept so every contributor (human or agent) works from the same
intent. Two literal mentions of the codename were replaced with `<project name>` placeholders,
because the name lives only in `PROJECT_NAME`.

## Amendments (decided 2026-11-09, override the brief below)

1. **License:** MIT.
2. **Package manager:** npm workspaces (not pnpm).
3. **Docker:** first-class. Users can run with `docker compose up` or with plain npm. Docker is
   the reference environment for development and testing (`npm run docker:dev`,
   `npm run docker:test`).
4. **Project name:** never hardcoded. It comes from `PROJECT_NAME` in `.env`; package names are
   generic (`@app/*`) and the config directory is derived from the name at runtime.
5. **Libraries:** any JavaScript library that helps the project is allowed (relaxes principle 6),
   but keep the dependency surface small and justify additions.
6. **Palette:** taken from myselfraj.com (see docs/VISUAL_LANGUAGE.md).
7. **Commits:** follow the gitsmith format in `.commitconfig.json`.

---

# Project: <project name> (working codename)

You are helping me build an open source, local-first infrastructure tool where my servers appear as a living "city of light" in 3D, and I can dive into any server and get a REAL SSH terminal. Visual reference: the entrance of my portfolio https://myselfraj.com (a lens dives "into the computer" where work is a "city of light", terminal aesthetic). Treat that as the visual DNA, pushed much further.

This is a passion project, not a SaaS. Quality, honesty of data and visual cohesion matter more than feature count.

## Founding principles (never break these)

1. Truth first. Every light, color, pulse and animation maps to one documented data field. An offline server must NEVER look operational. Stale data (older than 3x the poll interval) must look visibly frozen: desaturated, no motion, a "last seen" label.
2. The world is a map, never a gate. Every action reachable in 3D must also be reachable by keyboard (Cmd+K palette). The camera flies and jumps. There is no walking or WASD movement.
3. Local first. The app runs on my machine, binds to 127.0.0.1 only, and connects outward to my servers. No hosted backend, no telemetry, no cloud accounts.
4. Secrets never touch our storage. Use the system ssh-agent (SSH_AUTH_SOCK) or a key file path the user configures. Never write private keys, passphrases or passwords to disk, logs or the database.
5. Stylized, not realistic. Abstract emissive geometry, dark volumes, fog, a strict palette. No photoreal server racks, no downloaded or AI generated meshes. Everything procedural.
6. Small dependency surface. Use only the libraries listed below. Ask me before adding anything else and explain why.

## Scope of v0.1 (build only this)

SSH hosts with live system metrics, shown as a 3D city, with a cinematic dive into a real terminal.

Explicitly OUT of scope for v0.1 (do not build, but keep interfaces clean so they can be added): Docker, Kubernetes, S3, DNS, VPN, firewall, plugins, multi-user, auth providers, Windows/macOS remote hosts, mobile layout, VR.

## Tech stack

Monorepo with pnpm workspaces, TypeScript everywhere, shared types between client and server.

1. apps/web: Vite + React + TypeScript.
   3D: three (use WebGPURenderer with automatic WebGL2 fallback), @react-three/fiber, @react-three/drei, @react-three/postprocessing (bloom, vignette, subtle chromatic aberration only on transitions).
   Motion: gsap for camera dives and the intro sequence.
   Text in 3D: troika-three-text.
   Picking: three-mesh-bvh if needed for performance.
   State: zustand (single store mirroring server state).
   2D layer: @xterm/xterm with fit and webgl addons, cmdk for the command palette, motion (framer motion) for 2D panels, uplot for small charts.
   Dev only: leva for live tuning of glow, colors and camera.
2. apps/server: Node 22 + TypeScript, Fastify, ws for WebSockets, ssh2 for SSH, better-sqlite3 for storage, zod for validating config and messages, pino for logs.
3. packages/shared: zod schemas and TS types for the state model and WebSocket protocol.

## Data model (packages/shared)

Host: id, name, address, port, user, district (provider or group label), tags, auth method (agent | keyFile with path).
HostState: hostId, status (online | degraded | offline | unknown), lastSeenAt, stale (computed), cpu percent, load1/5/15, memory used/total, swap used/total, disks (mount, used, total), network rx/tx bytes per second per interface, uptime seconds, os/kernel string, error message if any.
Status rules: offline if SSH connect fails or heartbeat lost; degraded if cpu > 90% for 3 polls, memory > 90%, or any disk > 90%; unknown before first successful poll. Make thresholds configurable.

## Configuration

Hosts live in a YAML file at the user config dir (for example ~/.config/<project name>/hosts.yaml). Provide a command and a UI button to import hosts from ~/.ssh/config (Host, HostName, User, Port, IdentityFile). Validate with zod and show clear errors.

## Server architecture

1. Connection manager: one persistent ssh2 connection per host with keepalive, exponential backoff reconnect, and per host status events. Respect known_hosts. On an unknown or changed host key, refuse and surface it in the UI clearly (never auto accept).
2. Metrics poller: every 2 seconds (configurable) run ONE compact exec command per host on the existing connection that reads /proc/stat, /proc/meminfo, /proc/loadavg, /proc/net/dev, /proc/uptime and `df -P -k`. No agents installed on the remote host. Parse in pure functions with unit tests using captured fixture outputs. CPU and network rates are computed from deltas between polls.
3. State engine: holds the latest HostState per host, computes status and staleness, and pushes diffs to clients over WebSocket. Keep the last 48 hours of samples in SQLite at reduced resolution for history (used later for the time scrubber, just store it now).
4. Terminal: open a PTY shell channel on the same SSH connection when requested, stream over a dedicated WebSocket, handle resize, close cleanly.
5. Audit log: append-only SQLite table recording terminal session open/close, host, timestamps and connection events. Be honest in the docs that keystroke level command capture in a PTY is not reliable and is not claimed.
6. Local security: bind 127.0.0.1 only. On startup generate a random session token and print a URL containing it (like Jupyter). All HTTP and WebSocket requests require the token. Check the Origin header on WebSocket upgrades. No CORS wildcard.

## The visual world (apps/web)

Metaphor: the inside of a machine, a city of light.
1. Districts: one per district label (Hetzner, DigitalOcean, home lab, client X). Arranged on a dark grid floor with soft fog. District names float as thin troika labels.
2. Towers: one per host. Geometry is FIXED (no height or shape changes from metrics, so spatial memory stays stable). Data is expressed through light only:
   Edge glow color = status (one accent color per state, defined as design tokens).
   Pulse speed = CPU load.
   Horizontal light bands filling upward = memory usage.
   A base ring segmented by disk usage.
   Faint particles rising = network throughput.
   Offline = dark, no emissive, no motion. Stale = desaturated and frozen with "last seen Xs ago".
3. Layout: deterministic and stable. A host keeps its position across reloads (store positions in SQLite). New hosts are placed in free slots of their district.
4. Camera: orbit/fly with smooth damping. Clicking a tower or choosing it in Cmd+K flies the camera to it with a GSAP tween. Escape returns to the overview.
5. HUD on focus: a 2D panel unfolds next to the tower with live numbers, small uplot sparklines for CPU, memory and network, the host's OS, uptime and status reason.
6. Jack in: pressing Enter (or a button) on a focused tower triggers the signature transition, under 500ms and skippable: camera dives through the tower, the city dissolves into grid lines, and a full-screen xterm terminal resolves with a real shell. Exiting reverses the transition back to the tower.
7. Intro: a short entrance sequence in the spirit of myselfraj.com (lens enters the machine, city lights up host by host as real connections succeed). Always skippable, and auto-skipped after the first visit.
8. Command palette (Cmd+K): search hosts, jump to host, open terminal, toggle lite mode, toggle ambient mode, import from ssh config, open audit log.
9. Lite mode: disables post-processing and particles for weak GPUs. Auto-suggest it if frame time is bad for several seconds.
10. Demo mode: a mock adapter generating fake hosts so the world can be developed and screenshotted without servers. Demo mode must show a permanent visible "DEMO DATA" badge. Never mix demo and real data.

Design tokens: define palette, glow intensities, timing curves and durations in one tokens file. Maximum three accent colors plus neutrals. Write docs/VISUAL_LANGUAGE.md documenting every visual encoding (which field drives which effect). If an effect isn't in that document, it shouldn't exist.

Performance budget: 60fps on a mid-range laptop with integrated graphics for 50 hosts in full mode. Use instanced meshes for towers. Measure and report draw calls and frame time in a dev overlay.

## Build phases (stop after each phase, summarize, and wait for my review)

Phase 0: Scaffold monorepo, tooling (eslint, prettier, vitest), design tokens, docs/VISUAL_LANGUAGE.md draft, docs/ARCHITECTURE.md, docs/THREAT_MODEL.md draft. Deliver a plan first.
Phase 1: The world with demo mode. City, districts, towers with all light encodings, camera fly-to, Cmd+K, focus HUD, lite mode, dev perf overlay. Take Playwright screenshots of overview and focused states and critique them yourself against the principles before showing me.
Phase 2: Server. Config loading and ssh config import, connection manager, metrics poller with tested parsers, state engine, WebSocket protocol, token security, SQLite storage and audit log.
Phase 3: Wire live data into the world. Verify truth rules: kill a connection and confirm the tower goes offline; block polling and confirm it goes stale. Add tests for status computation.
Phase 4: Jack in. xterm terminal over WebSocket, resize, reconnect messaging, the dive transition and reverse.
Phase 5: Polish. Intro sequence, ambient mode (slow camera drifting toward unhealthy hosts, for a second monitor), audit log viewer panel, README with a GIF, MIT license, CONTRIBUTING.md, one-command start (`pnpm dev`), and a clear "what this does with your SSH access" section.

## Working rules

1. Before each phase, show a short plan and the files you will create.
2. Keep components small and the 3D scene code separate from data logic.
3. Never fake real-mode data. If something is unknown, show unknown.
4. Write unit tests for every parser and the status engine.
5. Use Playwright screenshots to check your visual work; describe what you see and what you will improve.
6. When unsure about a visual or product decision, ask me instead of guessing.
7. Commit at the end of each phase with a clear message.
