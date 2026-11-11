---
title: AI agents
description: 'Let Claude Code, Codex or Gemini investigate and act on your servers, with your approval for every command.'
---

# AI agents

Use the AI you already have. Nothing is wired to one vendor, and **every command an AI wants to run
pops up for you to approve first**: the exact command, the server and the AI's reason.

## Claude Code (and any MCP app)

```bash
gridcity mcp
```

It prints a `claude mcp add …` command (and JSON for other MCP apps such as Cursor or Claude
Desktop). Run it once; the app must be running when the AI calls it. In the app, **Ctrl+K → Ask an
AI agent…** shows the same command.

Then ask in plain words:

- "Why is the site down?"
- "Which server is running out of disk, and what is filling it?"
- "Update the packages on the staging servers."

## The tools

| Tool               | What the AI gets                                                          |
| ------------------ | ------------------------------------------------------------------------- |
| `incident_report`  | everything not healthy, grouped by likely root cause, and what is at risk |
| `diagnose`         | the [Doctor](./doctor.md) for one server or resource, with proven fixes   |
| `get_topology`     | links, and the blast radius of a building                                 |
| `list_servers`     | servers with status, CPU, memory, disks and discovered services           |
| `list_resources`   | databases, buckets, probes and load balancers with their metrics          |
| `list_runbooks`    | saved commands and where they apply                                       |
| `run_command`      | runs a shell command on one server **after you approve it**               |
| `wait_for_command` | collects a command that was still waiting for you                         |

Reference: [MCP tools](../reference/mcp-tools.md).

## Approval cards

Cards appear on top of everything, even an open terminal:

- **Allow**, **Allow all on this server** (until the app restarts), or **Deny**.
- **Add a note for the AI**: instructions or why you deny ("use apt, not snap").
- When a command needs a secret on stdin (a `sudo` password, a token for `--password-stdin`), the
  card asks **you** for it. It goes to the command only, never to the AI, never to the log.

### Allow all on this server

**Allow all** lets the AI work on that server without a card for every command, until the app
restarts or you untrust the server in the agent panel. It is never saved.

- **Everyday commands run straight away:** status checks, logs, restarts, installs, upgrades.
- **Destructive commands still ask**, and the card says why: deleting files, wiping disks, dropping
  database data, removing containers or packages, deleting users or cron jobs, stopping services,
  killing processes, clearing firewall rules, discarding git history, deleting cloud resources,
  rebooting or shutting down.
- **The AI can ask too:** it marks any command it judges hard to undo as `risky`, and that command
  asks even on a trusted server.
- **The sudo password is asked once.** Type it on the card where you choose Allow all, and the app
  keeps it in memory for that server and reuses it for later `sudo` commands. It is never written to
  disk, logged or shown to the AI. If sudo rejects it, the app forgets it and asks again.
- **Secrets the AI asks for**, such as a registry token, are asked every time.

Prefer **Allow** on servers that matter: command output can contain text that tries to steer the AI.

An AI is never left hanging: if you do not answer within 25 seconds, it is told to wait and collects
the result later with `wait_for_command`. Unanswered requests are denied after 5 minutes. Every
command run or denied is in the audit log, with who allowed it.

## Codex and Gemini CLI inside the app

**Ctrl+K → Ask an AI agent…**, pick an agent and **Start**. The app runs the vendor's open-source
adapter through the Agent Client Protocol and you sign in with your own account (ChatGPT, Google, or
an API key). You can type or talk to it. It works on servers only through the same tools and
approvals.

## Rules the AI follows

The tools tell the AI to explain why in each command, to prefer read-only checks before changing
anything, never to ask for passwords in chat, and to apply Doctor fixes only with your click in the
app.
