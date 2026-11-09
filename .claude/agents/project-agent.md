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

## Context
- License: Apache 2.0 (see `LICENSE`).

## How to work
- Read the relevant files before changing them; keep changes small and focused.
- Never commit `.env` or secrets. When you add a new environment variable, add it to `.env.example` with a safe placeholder value and document it in `README.md`.
- Keep `README.md` up to date when setup steps, commands, or structure change.
- If asked to rename the project: update `PROJECT_NAME` in `.env` and `.env.example`, and the title in `README.md` (the only place the name appears as literal text).
- Report what you changed and anything you could not verify.
