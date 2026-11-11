---
title: Testing
description: 'Unit tests, real-database tests, end-to-end tests and what each covers.'
---

# Testing

```bash
npm run check             # format, lint, typecheck, unit tests
npm run test:connectors   # real databases in Docker
npm run test:e2e          # Playwright against the built app
```

## Unit tests (vitest)

Pure functions carry the logic and are tested directly: collector and discovery parsers (on captured
output from real distributions), status rules, staleness, layout, topology (blast radius, root
causes), every Doctor rule against the real error texts drivers produce, fix verification, the
vault, replay frames, routes through `app.inject()`, and the MCP endpoint through the official MCP
client over real HTTP.

## Real databases

`npm run test:connectors` starts PostgreSQL, MySQL, a MySQL that **requires TLS** (to prove the
Doctor end to end), MongoDB, Redis and MinIO from `compose.connectors-test.yaml`, on unusual ports
bound to `127.0.0.1`, then runs the connector and Doctor integration tests. Add `--down` to remove
them afterwards, `--mssql` to include SQL Server.

## SSH

An in-process fake SSH server (`apps/server/src/testing/fake-ssh-server.ts`) speaks the real protocol
(key exchange, host keys, auth, exec, PTY), so the fleet, terminals, jump hosts and the connect flow
are tested without a real server.

## Writing tests

- Test the truth rules: unknown stays unknown, offline drops values, stale freezes.
- For a new Doctor rule, add the exact error text a driver produces to the table in
  `doctor.test.ts`.
- Never commit real credentials; test containers use throwaway values.
