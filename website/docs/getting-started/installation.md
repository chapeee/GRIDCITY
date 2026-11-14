---
title: Installation
description: 'Install GRIDCITY as a desktop app, with npm, run it with Docker, or build it from source.'
---

# Installation

GRIDCITY runs on Windows, macOS and Linux. The servers it watches must run Linux.

| How                 | Command                                                                                   | Needs                       |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------------- |
| Desktop app         | [Download](https://github.com/chapeee/GRIDCITY/releases/latest) or `npx gridcity-desktop` | Nothing (Chromium built in) |
| Try it once         | `npx gridcity demo`                                                                       | Node.js 22.12+ (24 is best) |
| Install the command | `npm i -g gridcity`                                                                       | Node.js 22.12+              |
| Docker              | `docker run … ghcr.io/chapeee/gridcity`                                                   | Docker                      |
| From source         | `git clone`, `npm install`, `npm run dev`                                                 | Node.js 22.12+              |

## Desktop app

Installers for Windows (`.exe`), macOS (`.dmg`) and Linux (`.AppImage`, `.deb`, `.rpm`) are on
the [latest GitHub release](https://github.com/chapeee/GRIDCITY/releases/latest). The app is
GRIDCITY in its own window with Chromium built in, and lives in the tray while it watches your
servers. See [Desktop app](./desktop-app.md).

## npm

The package is [`gridcity` on npm](https://www.npmjs.com/package/gridcity).

```bash
npm i -g gridcity
gridcity
```

The command prints a link such as `http://127.0.0.1:4600/?token=…`. Open it. The token stays the
same across restarts, so you can bookmark the link; `gridcity --new-token` replaces it and signs
out every browser.

Nothing needs compiling: the only native module (SQLite) ships prebuilt binaries for Linux, macOS
and Windows on x64 and arm64. Where that module is blocked (Windows Smart App Control or
Application Control, some antivirus), GRIDCITY uses the SQLite built into Node.js 22.16 or newer
instead.

See the [command reference](../reference/cli.md) for `gridcity doctor`, `gridcity mcp` and the
options.

## Docker

```bash
docker run -d --name gridcity -p 127.0.0.1:4600:4600 \
  -v gridcity-config:/config -v gridcity-data:/data \
  ghcr.io/chapeee/gridcity
docker logs gridcity
```

The logs show the link with your session token. The port is published on `127.0.0.1` only, so
nothing else on your network can reach it. Images are built for `linux/amd64` and `linux/arm64`.

To try the demo in Docker, add `node apps/server/dist/index.js --demo` after the image name. For
Compose, SSH agents and keys in containers, see [Docker](../guides/docker.md).

## From source

```bash
git clone https://github.com/chapeee/GRIDCITY.git
cd GRIDCITY
npm install
npm run demo        # simulated city
npm run dev         # your servers, with hot reload
```

For a production build from source: `npm run build && npm start` (one port, serves the built app).

## Where your data lives

| What                                                 | Linux / macOS              | Windows                    | Docker    |
| ---------------------------------------------------- | -------------------------- | -------------------------- | --------- |
| Config files (hosts, resources, districts, runbooks) | `~/.config/gridcity/`      | `%APPDATA%\gridcity\`      | `/config` |
| Database, history, audit log, encrypted credentials  | `~/.local/share/gridcity/` | `%LOCALAPPDATA%\gridcity\` | `/data`   |

You never have to edit these files: everything can be set up in the app. They exist so you can
version them, review them or script them. See [Configuration](../reference/configuration.md).
