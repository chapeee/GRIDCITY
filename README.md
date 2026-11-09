# GRIDCITY

A local-first infrastructure tool where your servers appear as a living **city of light** in 3D,
and you can dive into any server to get a real SSH terminal.

> **Status: Phase 1.** The 3D world runs on a simulated demo fleet (clearly badged as
> DEMO DATA). Real SSH hosts arrive in Phase 2–3, the terminal in Phase 4. See the
> [brief](docs/BRIEF.md) for the roadmap.

- **Truth first.** Every light maps to one documented metric. Offline never looks healthy; stale
  data looks frozen. See [docs/VISUAL_LANGUAGE.md](docs/VISUAL_LANGUAGE.md).
- **Local first.** Runs on your machine, binds to `127.0.0.1`, connects outward to your servers.
  No cloud, no telemetry, no accounts.
- **Your secrets stay yours.** Uses your ssh-agent or a key file path; never stores keys or
  passwords. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Quick start

Requires either **Docker** or **Node.js 22.12+** (24 recommended).

### With Docker

```bash
docker compose up --build
```

Open the URL printed in the logs. It contains a one-time session token.

### With npm

```bash
npm install
npm run build
npm start
```

## Development

Docker is the reference environment for development and testing, so everyone gets the same
results.

| Task                                   | Docker                | Native             |
| -------------------------------------- | --------------------- | ------------------ |
| Dev servers with hot reload            | `npm run docker:dev`  | `npm run dev`      |
| All checks (format, lint, types, test) | `npm run docker:test` | `npm run check`    |
| Browser tests + review screenshots     | `npm run docker:e2e`  | `npm run test:e2e` |

Dev mode serves the web app on <http://127.0.0.1:4601> and proxies `/api` and `/ws` to the
server on port 4600. Use the URL with the token printed in the console.

Browser test screenshots land in `test-results/screenshots/`. Docker renders with software
WebGL, so for real frame times run natively on your GPU: `WORLD_GPU=1 npm run test:e2e`
(first run: `npx playwright install chromium`).

Demo URL parameters: `?hosts=50` (1–200), `?seed=3`, `?poll=500` (ms).

In the world: **Ctrl/Cmd+K** command palette · **Tab / Shift+Tab** jump between hosts ·
**Esc** overview · **Enter** jack in (Phase 4) · **`** (backtick) performance overlay.

Other scripts: `npm run lint`, `npm run format`, `npm run typecheck`, `npm test`,
`npm run test:watch`.

If dependencies change while using Docker dev, the container runs `npm install` on start. To reset
the Docker `node_modules` volume:

```bash
docker compose -f compose.dev.yaml down -v
```

## Environment variables

Defaults live in `.env.example` (committed). Put local overrides in `.env` (git-ignored). Real
environment variables win over both.

| Variable       | Description                                  | Default            |
| -------------- | -------------------------------------------- | ------------------ |
| `PROJECT_NAME` | Name of the project (single source of truth) | see `.env.example` |
| `SERVER_PORT`  | API and production port                      | `4600`             |
| `WEB_PORT`     | Vite dev server port                         | `4601`             |
| `LOG_LEVEL`    | `fatal` … `trace`                            | `info`             |

## Renaming the project

The project name is kept in one place, `PROJECT_NAME`. To rename the project:

1. Change `PROJECT_NAME` in `.env` and `.env.example`.
2. Change the title (first line) of this README.

Code and config read `PROJECT_NAME` and never hardcode the name. Package names are generic
(`@app/web`, `@app/server`, `@app/shared`).

## Project structure

```
.
├── apps/
│   ├── server/          # Fastify server: SSH, metrics, state engine (loopback only)
│   └── web/             # Vite + React client; design tokens in src/design/tokens.ts
├── packages/
│   └── shared/          # Zod schemas + types shared by server and web
├── docs/                # Brief, architecture, visual language, threat model
├── Dockerfile           # dev / build / runtime stages
├── compose.yaml         # Run the app (users)
├── compose.dev.yaml     # Develop and test (contributors)
├── .commitconfig.json   # gitsmith commit format
└── .claude/agents/      # Claude Code project agent
```

## Contributing

- Commit messages follow the [gitsmith](https://www.npmjs.com/package/gitsmith) format in
  `.commitconfig.json`: `type(scope): message`.
- Run `npm run docker:test` before opening a pull request.

A Claude Code project agent lives in [`.claude/agents/project-agent.md`](.claude/agents/project-agent.md)
(invoke with `@project-agent`).

## License

[MIT](LICENSE)
