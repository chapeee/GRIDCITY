---
title: Reading the city
description: 'What every light, pulse, band, ring and particle means.'
---

# Reading the city

Every building has a **fixed shape** that tells its kind, and its geometry never changes with data,
so your spatial memory stays valid. Data is expressed through **light only**. There are three
accents: **cyan** is healthy, **amber** is over a threshold, **red** (2D only) is an error.

## Shapes

| Shape                            | Kind                                                   |
| -------------------------------- | ------------------------------------------------------ |
| Tower (tall box)                 | SSH server                                             |
| Drum (3 stacked discs)           | PostgreSQL, MySQL/MariaDB, MongoDB, SQL Server, SQLite |
| Hexagonal prism                  | Redis / Valkey                                         |
| Caged drum (drum in a frame)     | AWS RDS instance                                       |
| Warehouse (low slab, roof cells) | S3-compatible bucket                                   |
| Beacon (thin tall spire)         | HTTP or TCP probe                                      |
| Gate (low wide slab)             | AWS load balancer                                      |

## Servers (towers)

| You see                | It means                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| Edge color             | status: cyan online, amber degraded, faint outline unknown, none offline   |
| Edge pulse speed       | CPU: 0 % → 0.2 Hz, 100 % → 2 Hz                                            |
| Bands filling upward   | memory used, in tenths                                                     |
| Ring arcs at the base  | the 4 fullest disks; amber above the disk warning                          |
| Rising particles       | network traffic, log scale (none below 1 KiB/s)                            |
| Caption under the name | the degraded reason, "last seen …", "offline", or "waiting for first poll" |

## Databases and caches

| You see                 | It means                                                                   |
| ----------------------- | -------------------------------------------------------------------------- |
| Pulse (drum, prism)     | queries, transactions or commands per second (log scale)                   |
| Pulse (caged drum, RDS) | CPU percent                                                                |
| Lit discs / strips      | connections in use out of the maximum                                      |
| One ring arc            | storage used out of a known limit (Redis maxmemory, RDS allocated storage) |
| Roof cells (warehouse)  | stored bytes, log scale up to 10 TiB                                       |
| Particles (warehouse)   | bucket growth (only growth is drawn)                                       |

## Probes and load balancers

| You see          | It means                                                       |
| ---------------- | -------------------------------------------------------------- |
| Pulse (beacon)   | latency: a slow endpoint pulses fast (≤ 20 ms slow, 3 s fast)  |
| Pulse (gate)     | requests per second                                            |
| Lit bands (gate) | the share of healthy targets (all 6 lit: every target healthy) |

## Truth states

These override everything above:

| State       | Looks like                                                     |
| ----------- | -------------------------------------------------------------- |
| **Offline** | a dark volume: no light, no motion, no ring, no particles      |
| **Stale**   | grey (15 % saturation), every motion frozen, "last seen N ago" |
| **Unknown** | a faint outline only: present, not measured yet                |

An offline or stale building never looks operational. The browser recomputes staleness every second
on its own clock, so towers freeze even if the server stops sending.

## The floor

- **Districts** are raised plates with their name in front; click it to frame the district. The
  plate's rim is amber when anything inside is degraded or offline, cyan when every measured member
  is online, and muted when nothing has been measured yet.
- **Trouble beacons** are soft amber shafts of light above degraded buildings, so a problem shows
  from anywhere in the city. Offline buildings stay dark.
- **Links** are lines of light from user to used ([Topology](../guides/topology.md)); they never use
  an accent color, so they never compete with status.
- The grid, fog, sky, stars and floor reflections are atmosphere: static, never data.

## UI marks (not data)

A thin white ring on the floor marks the focused building. **REPLAY** marks
[time travel](../guides/time-travel.md). **DEMO DATA** marks the simulated city. **AI:** in a caption
means an AI agent is running a command there right now.
