# GRIDCITY

**Your servers as a living city of light.** A local-first infrastructure tool: every SSH host
becomes a tower whose light tells the truth about it, and you can dive into any tower for a real
terminal.

![Flying through the city, focusing a degraded host, and jacking in](docs/media/demo.gif)

- **Truth first.** Every light maps to exactly one metric. An offline server is dark and still;
  data that stopped arriving freezes and greys out with a "last seen" label. Nothing is ever
  faked. See [docs/VISUAL_LANGUAGE.md](docs/VISUAL_LANGUAGE.md).
- **Local first.** Runs on your machine, listens on `127.0.0.1` only, connects outward to your
  servers. No cloud, no account, no telemetry, no CDNs.
- **Your secrets stay yours.** Uses your ssh-agent or a key file path. Keys, passphrases and
  passwords are never stored. Unknown or changed host keys are refused, never auto-accepted.
- **The world is a map, never a gate.** Everything you can do with the mouse works from the
  keyboard (Ctrl/Cmd+K).

> **Status: v0.1 complete.** Live SSH metrics, the 3D city, real terminals, intro, ambient mode
> and audit log. Remote hosts must be Linux. See the [brief](docs/BRIEF.md) for the vision.

## Try it in one command

Requires **Node.js 22.12+** (24 recommended) or **Docker**.

```bash
npm install
npm run demo
```

Open the URL printed in the console. It contains a one-time session token. This serves a
**simulated fleet** (always labelled DEMO DATA) so you can explore without any SSH setup.

With Docker instead: set `DATA_MODE=demo` in `.env`, then `docker compose up --build`.

## Use it with your servers

```bash
npm install
npm run dev
```

Your hosts live in `hosts.yaml`, created with a commented example on first start:

| Platform    | Location                         |
| ----------- | -------------------------------- |
| Linux/macOS | `~/.config/<project>/hosts.yaml` |
| Windows     | `%APPDATA%\<project>\hosts.yaml` |
| Docker      | `./config/hosts.yaml`            |

(`<project>` is `PROJECT_NAME` in lowercase.) Edit it any time: the running app reloads it live.

```yaml
hosts:
  - id: web-01
    name: web-01
    address: 203.0.113.10
    user: ops
    district: Hetzner # one district per value
```

Or import every concrete host from `~/.ssh/config`, either from the empty-city screen and the
command palette, or from a terminal (safe to run again):

```bash
npm run import-ssh-config
```

**Easiest: Connect a server.** Press Ctrl+K and choose **Connect a server…** (or the button in
the empty city). Type `user@address`, then:

1. **Trust:** the app shows the server's fingerprint. Compare it and confirm; it is added to
   your `known_hosts`, like answering "yes" in `ssh`.
2. **Key:** pick a key from your ssh-agent or `~/.ssh`, **upload a key file** you were given (an
   AWS/cloud `.pem`, a PuTTY `.ppk`, or an OpenSSH `id_*`), or let the app create one. Uploaded
   keys are copied into your SSH folder; `.ppk` files are converted to OpenSSH format. Cloud
   servers usually already accept their key, so there is no password step.
3. **Install:** if the server doesn't accept the key yet, enter the password **once**. The app
   adds your public key to the server's `authorized_keys`; the password is never saved.
4. **Done:** the server is saved to `hosts.yaml` and lights up.

**Doing it by hand instead:** each host must be in `~/.ssh/known_hosts` (connect once with `ssh`
and verify the fingerprint), and your key must be in a running ssh-agent (`ssh-add`), or set
`auth: { method: keyFile, path: ~/.ssh/id_ed25519 }` for an **unencrypted** key. On Windows the
built-in OpenSSH agent works. `npm run add-host -- user@address` tests and saves one host.

For production use: `npm run build && npm start` (single port, serves the built app).

**Docker with real servers:** the container needs your SSH folder (and, on Linux/macOS, your
agent socket). Copy `compose.ssh.example.yaml` to `compose.ssh.yaml`, keep your platform's block, then:

```bash
docker compose -f compose.yaml -f compose.ssh.yaml up --build
```

## Reading the city

| You see                                 | It means                                                |
| --------------------------------------- | ------------------------------------------------------- |
| Cyan edges · amber edges                | online · over a threshold (CPU, memory or a disk)       |
| Edge pulse speed                        | CPU usage                                               |
| Horizontal light strips, filling upward | memory usage                                            |
| Segmented ring at the base              | each disk's usage; amber arc = that disk is nearly full |
| Particles rising around a tower         | network throughput (log scale)                          |
| Dark, motionless tower                  | **offline**; the HUD says why                           |
| Grey, dim, frozen tower, "last seen …"  | **stale**: data stopped arriving                        |
| Faint outline only                      | not measured yet                                        |

Every encoding, and the reasoning behind it: [docs/VISUAL_LANGUAGE.md](docs/VISUAL_LANGUAGE.md).

| Focus a host                           | Jack in                              | A refused host key                                   |
| -------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| ![Focus HUD](docs/media/focus-hud.png) | ![Terminal](docs/media/terminal.png) | ![Host key refused](docs/media/host-key-refused.png) |

## Controls

| Key                 | Action                                                              |
| ------------------- | ------------------------------------------------------------------- |
| Click a tower       | Fly there and open its HUD                                          |
| **Ctrl/Cmd+K**      | Command palette: search hosts, every action                         |
| **Tab / Shift+Tab** | Jump to the next / previous host                                    |
| **Enter**           | Jack in: a real terminal on the focused host                        |
| **Ctrl+Shift+X**    | Leave the terminal (Esc and Ctrl+K belong to the shell in there)    |
| **Esc**             | Close panels, stop ambient mode, back to the overview               |
| **A**               | Ambient mode: tour hosts that need attention (for a second monitor) |
| **`** (backtick)    | Performance overlay                                                 |

Also in the palette: lite mode (no bloom or particles, for weak GPUs, suggested automatically when
frames are slow), the audit log, importing from `~/.ssh/config`, and replaying the intro.

## What this does with your SSH access

- It opens one SSH connection **from your machine** to each host in `hosts.yaml`, using your
  ssh-agent or the key file you configured. Keys are read at connect time and never copied,
  logged or stored. Passphrases are never asked for.
- It verifies every host key against your `known_hosts`. Unknown, changed or revoked keys are
  refused and shown with their fingerprint; **nothing runs on that host**.
- It writes to your SSH setup only inside **Connect a server**, after you act: it appends a host
  key you confirmed to `known_hosts` (never replacing a changed one), may create a new key file
  (never overwriting one), and uses a password once, in memory, to add your public key to the
  server's `authorized_keys`.
- Every 2 seconds it runs **one fixed, read-only script** per host that reads `/proc`, `df` and
  `/etc/os-release`. It installs nothing and changes nothing on your servers.
- When you jack in, it opens an interactive shell on the existing connection. What you type runs
  with that user's permissions, exactly like `ssh`.
- It keeps an **append-only audit log** of connections, host key refusals and terminal sessions
  (opened/closed, with duration). It does **not** record what you type: capturing commands from a
  terminal is not reliable, and we don't pretend otherwise.
- The browser UI is reachable only from this machine, only with the session token printed at
  startup, and only from its own page (Host and Origin checks block other websites).

Details and limits: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Development

Docker is the reference environment for development and testing, so everyone gets the same
results.

| Task                                   | Docker                | Native             |
| -------------------------------------- | --------------------- | ------------------ |
| Dev servers with hot reload            | `npm run docker:dev`  | `npm run dev`      |
| All checks (format, lint, types, test) | `npm run docker:test` | `npm run check`    |
| Start the built server and verify it   | (part of docker:test) | `npm run smoke`    |
| Browser tests + review screenshots     | `npm run docker:e2e`  | `npm run test:e2e` |
| Re-record the README GIF               |                       | `npm run media`    |

Dev mode serves the web app on <http://127.0.0.1:4601> and proxies `/api` and `/ws` to the
server on port 4600. `?source=demo` runs the demo fleet entirely in the browser (no server);
`?hosts=50`, `?seed=3` and `?poll=500` tune it.

Docker renders with software WebGL, so for real frame times run the browser tests natively on
your GPU: `WORLD_GPU=1 npm run test:e2e` (first run: `npx playwright install chromium`).

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Environment variables

Defaults live in `.env.example` (committed). Put local overrides in `.env` (git-ignored). Real
environment variables win over both.

| Variable                 | Description                                              | Default            |
| ------------------------ | -------------------------------------------------------- | ------------------ |
| `PROJECT_NAME`           | Name of the project (single source of truth)             | see `.env.example` |
| `DATA_MODE`              | `real` (hosts.yaml over SSH) or `demo` (simulated fleet) | `real`             |
| `SERVER_PORT`            | API and production port                                  | `4600`             |
| `WEB_PORT`               | Vite dev server port                                     | `4601`             |
| `LOG_LEVEL`              | `fatal` … `trace`                                        | `info`             |
| `CONFIG_DIR`, `DATA_DIR` | Where hosts.yaml and the database live                   | OS conventions     |

## Renaming the project

The project name is kept in one place, `PROJECT_NAME`. To rename the project:

1. Change `PROJECT_NAME` in `.env` and `.env.example`.
2. Change the title (first line) of this README.
3. Re-record the README media, which shows the name on screen: `npm run media`.

Code and config read `PROJECT_NAME` and never hardcode the name. Package names are generic
(`@app/web`, `@app/server`, `@app/shared`).

## Project structure

```
.
├── apps/
│   ├── server/          # Fastify server: SSH, metrics, state hub, terminals (loopback only)
│   └── web/             # Vite + React + three.js client; design tokens in src/design/tokens.ts
├── packages/
│   └── shared/          # Zod schemas, protocols, status rules, demo fleet
├── e2e/                 # Playwright: demo world + full stack against in-process SSH servers
├── docs/                # Brief, architecture, visual language, threat model, media
├── scripts/             # Smoke test, README media recorder
├── Dockerfile           # dev / build / runtime stages
├── compose.yaml         # Run the app (users)
├── compose.dev.yaml     # Develop and test (contributors)
└── compose.ssh.example.yaml  # Opt-in SSH access for the container
```

## License

[MIT](LICENSE)
