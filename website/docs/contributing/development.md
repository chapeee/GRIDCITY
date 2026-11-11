---
title: Development
description: 'Set up the monorepo, run it, and find your way around.'
---

# Development

Requires Node.js 22.12+ (24 recommended). Docker is optional (the reference environment, and needed
for the connector tests).

```bash
git clone https://github.com/chapeee/GRIDCITY.git
cd GRIDCITY
npm install
npm run demo    # simulated city, hot reload
npm run dev     # your servers, hot reload
```

The web dev server runs on port 4601 and proxies to the API on 4600; open the link the server prints.

## Scripts

| Script                    | Does                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `npm run dev` / `demo`    | server and web with hot reload                              |
| `npm run check`           | format check, lint, typecheck, unit tests                   |
| `npm test`                | unit tests (vitest)                                         |
| `npm run test:connectors` | connector and Doctor tests against real databases in Docker |
| `npm run test:e2e`        | Playwright end-to-end tests                                 |
| `npm run build`           | build the web app and bundle the server                     |
| `npm run pack:npm`        | assemble the npm package in `release/npm`                   |
| `npm run docker:dev`      | the dev environment in Docker                               |

## Layout

```text
packages/shared/src     protocol, status rules, topology, Doctor model, replay, demo city
apps/server/src
  agent/                MCP endpoint, ACP bridge, approvals, fleet tools
  cli/                  doctor, mcp-setup, add-host, import-ssh-config
  config/               yaml files: parse, validate, write (comments kept)
  connectors/           one file per resource kind
  doctor/               ladder, rules, verification, SSH, environment
  fleet/                SSH fleet, resource fleet, state hub, topology, runbooks
  http/                 routes and the security guard
  metrics/              collector and discovery scripts and their parsers
  ssh/                  connections, keys, known_hosts, jump hosts
  storage/              SQLite: history, incidents, audit, vault
apps/web/src
  data/                 stores, API clients, the in-browser demo
  ui/                   panels, palette, Doctor, timeline
  world/                the 3D scene: buildings, links, labels, camera
website/                this documentation
```

## Renaming

The name lives only in `PROJECT_NAME`; package names are generic (`@app/*`), and folder names derive
from it at runtime.
