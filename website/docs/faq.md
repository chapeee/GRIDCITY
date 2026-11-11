---
title: FAQ
description: 'Short answers to common questions.'
---

# FAQ

**Is it free?** Yes, MIT licensed.

**Does anything leave my machine?** No. No telemetry, no account, no CDN. It connects outward only to
the servers and services you add.

**Do I install anything on my servers?** No. It reads `/proc`, `df`, `ss` and similar over SSH.

**Which servers are supported?** Linux (any distribution with `/proc` and a POSIX shell; Alpine and
Raspberry Pi OS included). The app itself runs on Windows, macOS and Linux.

**Is it a replacement for Prometheus or Grafana?** No. It is a live, spatial view of your fleet with
diagnosis, a terminal and AI tools. It keeps days of history, not months of metrics.

**How many servers?** Designed for 60 fps with 50 buildings on integrated graphics, and it stays
usable at several hundred (lite mode helps).

**Can my team use it?** Each person runs their own instance; it is single-user and local by design.

**Can AI agents break things?** Only through `run_command`, and every command waits for your click.

**Where are my passwords?** Encrypted in the local database; see [Security](./concepts/security.md).

**Can I edit the YAML files by hand?** Yes; the app reloads them live and keeps your comments when it
writes them.

**Why a city?** Because you remember where things are. A list resorts itself; a city stays put, so a
change of light is the first thing you notice.
