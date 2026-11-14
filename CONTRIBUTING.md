# Contributing

Thanks for helping. This project values **honest data, visual cohesion and quality over feature
count**, so a few rules matter more than usual.

## The rules that never bend

1. **Truth first.** Every light, color, pulse and animation maps to one documented data field.
   If you add or change a visual effect, document it in
   [docs/VISUAL_LANGUAGE.md](docs/VISUAL_LANGUAGE.md) in the same pull request. If it is not in
   that document, it should not exist. Unknown values are shown as unknown, never as zero.
2. **An offline server must never look operational,** and stale data must look frozen.
3. **Local first.** No hosted services, telemetry, analytics, CDNs or remote fonts. The daily update
   check to GitHub's public releases page is the only exception: it sends nothing about the user and
   can be turned off.
4. **Secrets never touch our storage.** No keys, passphrases or passwords on disk, in logs or in
   the database. Security-relevant changes update [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
5. **The world is a map, never a gate.** Anything reachable with the mouse is reachable by
   keyboard (usually through the command palette).
6. **Never hardcode the project name.** It comes from `PROJECT_NAME`; see the README.

## Setup

```bash
npm install
npm run demo        # simulated fleet, no SSH needed
npm run dev         # your real hosts.yaml
```

Docker is the reference environment: `npm run docker:dev`, `npm run docker:test`,
`npm run docker:e2e`.

## Before opening a pull request

```bash
npm run check       # format, lint, typecheck, unit tests
npm run test:e2e    # browser tests (builds first)
```

Or run everything in Docker: `npm run docker:test` and `npm run docker:e2e`.

- **Parsers and status logic** are pure functions with unit tests. New remote output formats come
  with a captured fixture in `apps/server/src/metrics/fixtures/` (real captures preferred; label
  synthetic ones).
- **SSH behavior** is tested end to end against the in-process SSH server in
  `apps/server/src/testing/fake-ssh-server.ts`. No test talks to a real machine.
- **Visual changes** come with a look at the Playwright screenshots
  (`test-results/screenshots/`). Describe what you checked.
- Keep 3D scene code (`apps/web/src/world/`) separate from data logic (`apps/web/src/data/`).
- New dependencies need a reason in the pull request description. Install scripts stay off unless
  a package truly needs one (`allowScripts` in `package.json`).

## Code style

- Clear, descriptive names; units in names or docs (`Ms`, `Bytes`, `Percent`).
- Comments explain _why_ and the non-obvious (security reasons, truth rules), not what the code
  already says. Exported functions get a short TSDoc comment.
- Prettier and ESLint are the authority: `npm run format`.

## Commits

Commit messages follow the [gitsmith](https://www.npmjs.com/package/gitsmith) format configured
in `.commitconfig.json`: `type(scope): message`, header up to 72 characters, using the listed
types and scopes. gitsmith is a dev dependency: stage your changes and run `npm run commit`, which
asks for the type, scope and message. Scripts and AI agents can skip the questions with
`npx gitsmith -t <type> -s <scope> -m "<message>"`, and `npx gitsmith check "<header>"` checks a
message without committing.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
