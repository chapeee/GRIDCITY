---
title: Runbooks and fleet commands
description: 'Saved commands, run on one server or many, with one result row per server.'
---

# Runbooks and fleet commands

Press **R** (on a focused server, a focused district, or anywhere), or **Ctrl+K → Run a command on
servers…**

1. **What:** pick a runbook, or **A command, this once** and type it.
2. **Where:** tick servers, a whole district, or a tag (`#web`, `#docker`). Runbooks that only apply
   to some servers show only those.
3. **Run on N servers**, then confirm. Runbooks not marked read-only say they may change things.
4. **Results:** one row per server with the exit code and duration; failed rows open with their
   output (stderr in amber). Servers that are not connected say so instead of being skipped.

Commands run with `sh -c` as each server's user over the connection the city already holds, four
servers at a time, with a timeout. There is no terminal: add `-y` or `-n` where a tool would ask.
Every run is in the audit log: the command, the servers and the exit codes (never the output).

## Built-in runbooks

All read-only: top processes, what fills the disk, listening ports, failed services and recent
errors, containers with resource usage, recent kernel and system errors, pending updates, who is
connected, and TLS certificates on the server.

## Your own

```yaml title="runbooks.yaml"
runbooks:
  - id: restart-nginx
    name: Restart nginx
    description: Reload the config, or restart if the reload fails.
    command: sudo -n systemctl reload nginx || sudo -n systemctl restart nginx
    match:
      tags: [web] # any of these tags
      districts: [Hetzner] # or these districts
      hosts: [web-01] # or these servers
    timeoutSeconds: 60
  - id: docker-prune
    name: Prune unused docker data
    command: docker system prune -f
    match: { tags: [docker] }
```

An entry with a built-in's id replaces that built-in. The file reloads live.

AI agents see runbooks through `list_runbooks` and run them with `run_command`, which waits for
your approval as always.
