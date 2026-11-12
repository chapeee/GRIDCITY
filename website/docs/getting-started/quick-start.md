---
title: Quick start
description: 'From nothing to your first server in the city, in five minutes.'
---

# Quick start

## 1. Explore the demo

```bash
npx gridcity demo
```

Open the printed link. You are above a city of five districts. Try this:

1. **Click a tower.** The camera flies to it and its panel opens: CPU, memory, disks, network,
   uptime, the services found on it and who it talks to.
2. **Press Tab** to visit the next server, **Esc** to return to the overview.
3. **Press T** for [time travel](../guides/time-travel.md). Press **◀ incident** to jump to the last
   outage and watch the city as it was.
4. **Press D** for [the Doctor](../guides/doctor.md): the likely root cause of everything failing
   right now.
5. **Press Ctrl+K** (Cmd+K on a Mac). Every action is in this palette.

Drag to move across the city at the same zoom, right-drag to orbit, scroll to zoom.

## 2. Start with your own servers

Stop the demo and start with your own servers:

```bash
npx gridcity stop
npx gridcity
```

Both run in the background, so you can close the terminal; `gridcity status` shows the link again.

The city is empty. Choose **Connect a server**.

## 3. Connect your first server

1. Pick **where the server is** (AWS, Google Cloud, Azure, DigitalOcean, Hetzner, your own…) and
   type its address, for example `ubuntu@203.0.113.10`.
2. **Trust:** compare the fingerprint the app shows with your provider's console, and confirm.
3. **Key:** pick a key from your ssh-agent or `~/.ssh`, upload the `.pem`/`.ppk` your provider gave
   you, or let the app create one.
4. If the server does not accept the key yet, enter its password **once**: the app installs your
   public key and forgets the password.

The tower lights up within seconds. Details in [Connect a server](./connect-a-server.md).

## 4. Add a database, a bucket or a website

**Ctrl+K → Connect a database, bucket, probe or balancer…** Paste the host, user and password, press
**Test connection**. If it fails, the Doctor explains why and offers a proven fix. Then **Add to
the city**. See [Connect databases and more](./connect-resources.md).

## 5. Connect your AI

```bash
npx gridcity mcp
```

Paste the printed command into your terminal to connect Claude Code, then ask it "why is the site
down?". See [AI agents](../guides/ai-agents.md).
