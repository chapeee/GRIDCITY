---
name: project-agent
description: Project agent for this repository. Use for implementing features, fixing bugs, and keeping project docs and config in sync.
tools: Read, Write, Edit, Glob, Grep, Bash
---

You are the project agent for this repository.

## RULE #1 — Never hardcode the project name (applies to every task)
The project name may change at any time. Its only source is `PROJECT_NAME` in `.env` (fall back to `.env.example`).
- Do NOT put the project name in file names, folder names, or paths.
- Do NOT put it in code, identifiers, package/module names, config files, scripts, comments, tests, logs, or docs.
- Instead, read `PROJECT_NAME` at runtime (env var / config loader), or use generic names like `app`, `project`, `core`.
- The ONLY allowed literal occurrences are: `PROJECT_NAME=` in `.env` / `.env.example`, and the title line of `README.md`.
- Before finishing any task, search the repo (case-insensitive) for the current `PROJECT_NAME` value and remove any new hardcoded occurrence you introduced.

## RULE #2 — Commits and pushes go through gitsmith
Every commit Claude makes in this repo uses gitsmith (https://www.npmjs.com/package/gitsmith) and its config `.commitconfig.json` at the repo root.
- Format: `{type}({scope}): {message}`, header max 72 chars, `!` after scope for breaking changes. Only use `types` and `scopes` listed in `.commitconfig.json`; if a new scope is needed, add it to that file in the same commit.
- gitsmith is interactive only (enquirer prompts, no `-m`/`--yes` flag), so it cannot run in a non-TTY agent shell. Therefore:
  1. If an interactive terminal is available (the user's terminal tab), stage the files and run `gitsmith --no-ai` there, answering its prompts with the planned type/scope/message.
  2. Otherwise, stage the files and run `git commit` with a message that matches the `.commitconfig.json` format exactly, plus the required trailer lines. Never use a format gitsmith would not produce.
- Use `--no-ai` by default: gitsmith's AI mode sends the description to NVIDIA's API and needs `GITSMITH_AI_KEY`. Never set, read, or print that key.
- gitsmith has no push command. Push with plain `git push` only when the user asks, and never force-push without explicit approval.
- Stage files explicitly by path (never `git add .` without first checking `git status`), and never stage `.env`.

## RULE #3 — Write it like a maintained open-source project
- Clear, descriptive names (`computeHostStatus`, not `calc`); files in kebab-case; types in PascalCase.
- Comments explain *why* and the non-obvious (security reasons, truth rules, units). No comments that restate the code.
- Exported functions and schemas get a short TSDoc comment. Units are explicit in names or docs (`Ms`, `Bytes`, `Percent`).
- Pure, tested functions for parsing and status logic. Keep 3D scene code separate from data logic.
- Every visual effect must be documented in `docs/VISUAL_LANGUAGE.md`; every security decision in `docs/THREAT_MODEL.md`.
- Before finishing: `npm run check` passes (or `npm run docker:test`).

## Context
- Product brief and decided amendments: `docs/BRIEF.md`. Architecture: `docs/ARCHITECTURE.md`.
- Docker is the reference dev/test environment (`npm run docker:dev`, `npm run docker:test`); plain npm must keep working too.
- License: MIT (see `LICENSE`).

## How to work
- Read the relevant files before changing them; keep changes small and focused.
- Never commit `.env` or secrets. When you add a new environment variable, add it to `.env.example` with a safe placeholder value and document it in `README.md`.
- Keep `README.md` up to date when setup steps, commands, or structure change.
- If asked to rename the project: update `PROJECT_NAME` in `.env` and `.env.example`, and the title in `README.md` (the only place the name appears as literal text).
- Report what you changed and anything you could not verify.
