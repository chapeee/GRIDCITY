---
title: Truth first
description: 'Why GRIDCITY never fakes a number, and how it shows what it does not know.'
---

# Truth first

A dashboard that looks healthy while data stopped arriving is worse than no dashboard. GRIDCITY's
first rule: **every light maps to exactly one documented data field, and unknown is never shown as
zero or healthy**.

## The rules

1. **Unknown is unknown.** Every metric is nullable. `null` is drawn as "no light" and shown as a
   dash, never as `0`. Rates (CPU, network, queries per second) stay unknown until two polls exist.
2. **Offline is dark.** A server whose connection failed has no light and no motion. Its last
   values are not shown as current.
3. **Stale freezes.** Data older than three poll intervals freezes and turns grey with "last seen N
   ago", in the city and in the panels, recomputed every second in the browser.
4. **Demo is labelled.** The simulated city always shows **DEMO DATA**, and demo and real data are
   never mixed in one session.
5. **The past is labelled.** [Time travel](../guides/time-travel.md) shows **REPLAY**, and anything
   not recorded at that moment is unknown.
6. **Status rules are one function.** Server and browser compute status the same way (from
   `packages/shared`), and the demo runs its fake samples through the real rules.
7. **Could not tell ≠ none.** [Service discovery](../guides/services.md) says when a tool is
   missing, rather than "no containers".
8. **Proven or not.** The [Doctor](../guides/doctor.md) marks a fix _proven_ only when a real
   connection with it succeeded.

## Status

| Status     | Server                                                    | Resource                                                                                                                                 |
| ---------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown`  | never polled successfully                                 | never polled successfully                                                                                                                |
| `online`   | connected, within all thresholds                          | reachable, within all thresholds                                                                                                         |
| `degraded` | CPU > 90 % for 3 polls, memory > 90 %, or any disk > 90 % | connections, lag, slow queries, cache hit, storage, latency, certificate, targets (see [Resource kinds](../reference/resource-kinds.md)) |
| `offline`  | SSH connect failed or heartbeat lost                      | the poll failed                                                                                                                          |

All thresholds are configurable (Settings, per-server in Edit, `resources.yaml`).
