---
title: Contributing
description: 'How to help: issues, pull requests, docs.'
---

# Contributing

Thank you for helping. Small, focused pull requests are easiest to review.

- **Bugs and ideas:** open an issue with what you did, what you expected and what happened (the
  Doctor's report or `gridcity doctor --json` output helps a lot; remove anything private).
- **Code:** see [Development](./development.md) and [Testing](./testing.md). Every change keeps
  `npm run check` green.
- **Docs:** every page has an **Edit this page** link. The site is Docusaurus in `website/`
  (`cd website && npm install && npm start`).
- **Commits** follow the format in `.commitconfig.json` (`feat(web): …`, `fix(server): …`), made
  with [gitsmith](https://www.npmjs.com/package/gitsmith): `npm run commit`.

## Ground rules

- Truth first: never draw a value the data does not support.
- Secrets never reach logs, the audit log, the browser or an AI.
- Every new visual encoding is documented in `docs/VISUAL_LANGUAGE.md`.
- Every new rule, parser or status decision gets a unit test.
