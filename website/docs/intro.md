---
slug: /
sidebar_label: Overview
title: GRIDCITY
description: 'Your servers, databases, buckets, load balancers and probes as a living 3D city of light.'
---

# GRIDCITY

**Your servers as a living city of light, with a Doctor that proves its fixes.**

GRIDCITY is a local-first infrastructure tool. Every SSH server, database, bucket, load balancer
and HTTP/TCP endpoint becomes a building in a 3D city, and its light tells the truth about it:
pulse speed is load, lit bands are memory or connections, rings are disks, rising particles are
traffic. An offline server is dark and still. Data that stopped arriving freezes and greys out.

![The city: districts of servers, databases and probes](/img/overview.png)

## What you can do

| You want to…                                    | In GRIDCITY                                              |
| ----------------------------------------------- | -------------------------------------------------------- |
| See every server, database and endpoint at once | The city, grouped in [districts](./guides/districts.md)  |
| Know why something cannot connect, and fix it   | [The Doctor](./guides/doctor.md) (press **D**)           |
| See what happened at 3 a.m.                     | [Time travel](./guides/time-travel.md) (press **T**)     |
| Find the real cause when many things fail       | [Root cause and blast radius](./guides/topology.md)      |
| Open a shell on a server                        | [Jack in](./guides/terminal.md) (press **Enter**)        |
| Run a command on twenty servers                 | [Runbooks](./guides/runbooks.md) (press **R**)           |
| Let Claude Code investigate, with your approval | [AI agents](./guides/ai-agents.md) over MCP              |
| See who is attacking what                       | [Security](./guides/security.md): brute force, exposures |
| Be told when something breaks                   | [Alerts](./guides/alerts.md): push, email, chat, phone   |

## Try it in ten seconds

```bash
npx gridcity demo
```

Open the link it prints. The demo is a simulated city, always labelled **DEMO DATA**, that behaves
like a real one: load follows the day, servers spike, leak memory and reboot.

## Principles

- **Truth first.** Every light maps to exactly one documented metric. Unknown is shown as unknown,
  never as zero or healthy. Replays are labelled REPLAY. See [Truth first](./concepts/truth-first.md).
- **Local first.** One process on your machine, listening on `127.0.0.1` only, connecting outward.
  No cloud, no account, no telemetry, no CDN.
- **Your secrets stay yours.** SSH private keys and passphrases are never stored. Passwords and
  keys you paste in the app are encrypted on your machine. See [Security](./concepts/security.md).
- **A map, never a gate.** Everything the mouse can do, the keyboard can do (Ctrl/Cmd+K).

## Next

- [Install](./getting-started/installation.md) with npm or Docker.
- [Quick start](./getting-started/quick-start.md): from nothing to your first server.
