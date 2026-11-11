# Visual language

> **Rule:** every light, color, pulse and animation maps to exactly one documented data field.
> If an effect is not in this document, it should not exist. Values live in
> [`apps/web/src/design/tokens.ts`](../apps/web/src/design/tokens.ts); the mapping code is
> [`apps/web/src/world/host-visuals.ts`](../apps/web/src/world/host-visuals.ts) (unit tested).

Status: **v0.1**. Driven by live server data (or the demo fleet, always badged).

## Palette

Derived from the entrance of [myselfraj.com](https://myselfraj.com): a blue-black void, a cyan
"city of light" glow and icy text, set in IBM Plex Mono (bundled locally). At most **three
accents**; everything else is neutral.

| Token                  | Value                   | Used for                                              |
| ---------------------- | ----------------------- | ----------------------------------------------------- |
| `accents.online`       | `#8fe3ff`               | Healthy host glow                                     |
| `accents.degraded`     | `#ffc22d`               | Host over a threshold; disk arcs over limit           |
| `accents.alert`        | `#ff3b30`               | 2D only: errors, host-key refusals, protocol mismatch |
| `neutrals.void`        | `#020406`               | Fog, far background                                   |
| `neutrals.base`        | `#050708`               | Scene clear color, page background                    |
| `neutrals.surface`     | `#0b1316`               | HUD and palette panels                                |
| `neutrals.grid`        | `#0b1f29`               | Floor grid, dark tower volumes, empty disk track      |
| `neutrals.gridSection` | `#123544`               | Every fourth floor line (tower slot pitch)            |
| `neutrals.line`        | `rgba(143,227,255,0.2)` | Hairlines, panel borders, district outlines           |
| `neutrals.muted`       | `#4d5759`               | Unknown status, stale/frozen elements, secondary text |
| `neutrals.text`        | `#d8f3fb`               | Primary text                                          |
| `neutrals.textBright`  | `#eef9ff`               | Emphasized numbers                                    |

## Host encodings (towers)

Tower **geometry is fixed**: every tower is the same box. Height and shape never change with
metrics, so spatial memory stays stable. Data is expressed through light only.

| Effect                     | Data field                                | Mapping                                                                                                                                               | When the field is `null` |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Edge glow color            | `HostState.status`                        | `online` → online accent · `degraded` → degraded accent · `unknown` → faint muted outline · `offline` → none                                          | n/a (status always set)  |
| Edge pulse speed           | `HostState.cpuPercent`                    | Linear, 0 % → 0.2 Hz, 100 % → 2.0 Hz. Brightness swings ±28 %. Towers are phase-offset so they never pulse in sync.                                   | Steady glow, no pulse    |
| Memory bands (fill upward) | `HostState.memory.usedBytes / totalBytes` | 10 thin strips on the side faces; lit (in the status color) = `round(ratio × 10)`, the rest faintly visible                                           | No strips drawn          |
| Base ring arcs             | `HostState.disks[]`                       | One arc per disk, filled clockwise by `used / total`. Max 4 arcs: the **fullest** 4 disks, ordered by mount path                                      | No ring                  |
| Arc color                  | disk `used / total` vs threshold          | Status color normally; degraded accent above `diskDegradedPercent`                                                                                    | —                        |
| Rising particles           | `Σ HostState.network[].rx + tx` (B/s)     | Log scale: none below 1 KiB/s, max rate (24 /s) at 100 MiB/s. Each particle rises for 2.6 s.                                                          | No particles             |
| Name label                 | `Host.name`                               | Text above the tower                                                                                                                                  | —                        |
| Caption (second line)      | status / staleness                        | Degraded → `statusReason` in the degraded accent · stale → "last seen _N_ ago" · offline → "offline · last seen" · unknown → "waiting for first poll" | —                        |
| Label tone                 | status / staleness                        | Dim (muted) for offline, unknown and stale hosts                                                                                                      | —                        |

### Truth states (override everything above)

| State     | Trigger                                                                     | Look                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offline` | `status === 'offline'`                                                      | Dark volume. **No emissive light, no motion**, no ring, no particles. Metrics are unknown, so the HUD shows dashes.                                     |
| Stale     | `stale === true` **or** `lastSeenAt` older than 3 polls on the client clock | Saturation 15 %, **all motion frozen** (pulse and particles hold the frame they froze on), caption "last seen _N_ ago". Last known values stay visible. |
| `unknown` | `status === 'unknown'` (never polled)                                       | Faint muted outline only: no bands, no ring, no pulse, no particles. Reads as "present, not measured".                                                  |

An offline or stale server must never look operational. The client recomputes staleness every
second from `lastSeenAt`, so towers freeze even if the server itself stops sending.

## Resource encodings (databases, RDS, buckets)

Mapping code: [`apps/web/src/world/resource-visuals.ts`](../apps/web/src/world/resource-visuals.ts)
(unit tested); shapes: [`building-geometry.ts`](../apps/web/src/world/building-geometry.ts). Each
kind has one **fixed shape**, so the kind reads at a glance and never changes with data. Same
palette, same three accents, same truth states as towers (offline dark and still, stale grey and
frozen, unknown a faint outline). They share districts and the sticky slot layout with hosts.

| Kind                                                   | Shape                                              |
| ------------------------------------------------------ | -------------------------------------------------- |
| PostgreSQL, MySQL/MariaDB, MongoDB, SQL Server, SQLite | **Drum**: 3 stacked discs                          |
| Redis                                                  | **Hexagonal prism**, half a tower high             |
| AWS RDS instance                                       | **Caged drum**: 4 discs inside a thin static frame |
| S3-compatible bucket                                   | **Warehouse**: low wide slab, 5 × 2 roof cells     |

| Effect                    | Data field                              | Mapping                                                                                                                     | When `null`  |
| ------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Edge glow color           | `ResourceState.status`                  | Same as towers (rims of each disc, prism corners and rims, slab edges)                                                      | n/a          |
| Pulse speed (drum, prism) | `gauges.opsPerSec`                      | Log scale: ≤ 1 op/s → 0.2 Hz, 10 000 op/s → 2.0 Hz (same range as CPU)                                                      | Steady glow  |
| Pulse speed (caged drum)  | `gauges.cpuPercent` (CloudWatch)        | Linear, like a host's CPU                                                                                                   | Steady glow  |
| Pulse (warehouse)         | none                                    | Storage has no "load": buckets never pulse                                                                                  | —            |
| Lit discs / strips        | `gauges.connections.used / max`         | Drum: one disc per third, lit bottom-up; prism: 6 strips. RDS reports no maximum, so it has none                            | No discs lit |
| Roof cells (warehouse)    | `gauges.storage.usedBytes`              | Log scale, 1 KiB → 0 cells, 10 TiB → 10 cells (front-left first; at least 1 once anything is stored)                        | No cells     |
| Base ring (one arc)       | `gauges.storage.usedBytes / totalBytes` | Only when a limit exists: Redis `maxmemory`, RDS allocated storage. Amber exactly when the server's storage rule fired      | No ring      |
| Rising particles          | `gauges.growthBytesPerHour` (buckets)   | Positive growth only, log scale 1 MiB/h → none, 100 GiB/h → max rate. Shrinking or capped counts: none                      | No particles |
| Name label                | `Resource.name`                         | Text above the building                                                                                                     | —            |
| Caption                   | status / staleness / `Resource.engine`  | Healthy → engine ("PostgreSQL", "RDS · mysql", "S3 · R2"); degraded → reason (amber); stale and offline as towers           | —            |
| Cage (RDS only)           | none (kind marker)                      | Thin static frame in `neutrals.gridSection`. Never lit, never animated: an offline instance is a dark drum in a faint frame | —            |

Degraded rules (server, [`resource-status.ts`](../packages/shared/src/resource-status.ts)):
connections > 90 % of max, replica lag > 30 s, slow queries for 3 polls in a row, cache hit < 90 %
(judged only with ≥ 100 reads in the poll), storage > 90 % of a known limit, RDS CPU > 90 % for
3 polls, or a connector warning (replica link down, replication stopped, instance rebooting). All
configurable in `resources.yaml`. Stale: no data for 3 of that resource's own poll intervals.
CloudWatch datapoints keep their own timestamp, so old metrics freeze instead of looking live.

The resource HUD lists every metric the connector reported (dashes for unknown, "≥ N" when a
bucket count was capped) and one sparkline of the value that drives the building's light. It has
no "Jack in": Enter on a resource says there is no shell.

## World

| Effect          | Driven by          | Notes                                                                 |
| --------------- | ------------------ | --------------------------------------------------------------------- |
| District block  | `Host.district`    | One per distinct label, sorted by name; thin outline on the floor.    |
| District label  | `Host.district`    | Name in capitals, floating low in front of the district.              |
| Tower position  | Sticky layout slot | Not data. A host keeps its slot; new hosts take the lowest free slot. |
| Fog, grid floor | none (atmosphere)  | Static; never animated.                                               |
| Bloom, vignette | none (atmosphere)  | Off in lite mode.                                                     |

## 2D layer

| Element                | Driven by                                     | Notes                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status dot             | status / staleness                            | Online/degraded: filled accent with glow · offline: dark ring · unknown: dashed ring · stale: grey                                                                                                                                                                         |
| HUD left border        | status / staleness                            | Accent for online/degraded, muted otherwise                                                                                                                                                                                                                                |
| HUD frozen look        | staleness                                     | Whole panel greyscale, reason reads "Data frozen · last seen _N_ ago"                                                                                                                                                                                                      |
| Sparklines             | last 90 polls of CPU %, memory %, network B/s | Gaps where values were unknown; status color, grey when stale                                                                                                                                                                                                              |
| Disk bars              | disk `used / total`                           | Degraded accent above the disk threshold                                                                                                                                                                                                                                   |
| Error line             | `HostState.error`                             | Alert accent                                                                                                                                                                                                                                                               |
| Host key refusal panel | `hostKeyRefused` (reason, fingerprint)        | Alert-accent box in the HUD: "Unknown host key" or "Host key CHANGED", the SHA256 fingerprint and the safe next step. Clears once the host is reachable.                                                                                                                   |
| Connection banner      | browser ↔ server link                         | Alert banner while reconnecting ("hosts freeze as data goes stale") or when the session expired. Nothing while connected.                                                                                                                                                  |
| Config error banner    | server `error` message                        | Alert banner with the hosts.yaml problems; the last valid fleet keeps running.                                                                                                                                                                                             |
| History timeline       | status transitions (`status_events`)          | One strip over the chosen range: amber segment = degraded ("over a threshold"), dark segment with alert-accent edges = offline, plain track = online or no record. Never interpolated.                                                                                     |
| History charts         | stored metric buckets (`metric_samples`)      | CPU, memory, fullest disk (0–100 %) and network over the range, in the online accent; **gaps where no data was stored** (offline, app not running), never drawn as zero. A dashed degraded-accent line marks the host's own warning threshold.                             |
| Incident list          | incidents (degraded / offline periods)        | "overloaded" (degraded accent) or "offline" (alert accent), the reason when it started, start time, duration or "ongoing".                                                                                                                                                 |
| Connect a resource     | dialog state                                  | Kind tiles, then a short form. **Test connection** result: online-accent border "Connected" with what was read, or alert-accent border "Could not connect" with the reason. A degraded-accent hint warns when a host is "localhost" (inside Docker that is the container). |
| Settings panel         | app settings + hosts.yaml thresholds          | Retention days and the file-wide warning thresholds. Read-only with demo data ("DEMO DATA" note).                                                                                                                                                                          |
| Edit dialog            | one host in hosts.yaml                        | Name, district, tags and the host's own warning thresholds (placeholders show the defaults). Real mode only.                                                                                                                                                               |
| "Own warnings" line    | `Host.thresholds`                             | In the HUD, only when the host overrides a threshold. Its disk arcs and bars use the host's own disk threshold.                                                                                                                                                            |
| Empty city panel       | real mode with zero hosts                     | Where hosts.yaml is, a one-click import from ~/.ssh/config, and the known_hosts requirement.                                                                                                                                                                               |

## UI state effects (not data)

These show _what the user is doing_, never host health.

| Effect                       | Trigger                                                | Notes                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Camera fly-to (900 ms)       | Focus a host (click, Tab, palette)                     | `expo.inOut`; instant with `prefers-reduced-motion`. Tower is framed left of center to make room for the HUD.                                                                                                                                                            |
| Return flight (700 ms)       | Escape                                                 |                                                                                                                                                                                                                                                                          |
| HUD unfold (220 ms)          | Focus a host                                           |                                                                                                                                                                                                                                                                          |
| Focus ring                   | A host is focused                                      | Thin neutral (text-bright) ring on the floor just outside the disk ring. Host labels hide while focused; the HUD names the host.                                                                                                                                         |
| Jack-in dive (450 ms)        | Enter / "Jack in" on a reachable host                  | Camera plunges through the tower (`power4.in`), grid lines rush outward and the city dissolves into them, chromatic aberration ramps up. Any key or click skips it. The HUD folds away. Instant with `prefers-reduced-motion`.                                           |
| Surfacing (450 ms)           | Ctrl+Shift+X, "Back to the city", or the shell exiting | The reverse: aberration fades, grid recedes, camera returns to the focus view.                                                                                                                                                                                           |
| Chromatic aberration         | jack-in transition only                                | Zero at all other times.                                                                                                                                                                                                                                                 |
| Terminal status badge        | terminal connection                                    | connecting · connected (online accent) · session ended · disconnected / failed (alert accent) · demo data (neutral).                                                                                                                                                     |
| Intro (≈ 3.8 s, first visit) | page load, until seen once                             | A glowing lens opens and swallows the screen ("entering the machine"), then the camera descends onto the city. Towers are not staged: they start as unknown outlines and light up only as real connections succeed. Any key or click skips; replayable from the palette. |
| Ambient mode                 | A key or palette                                       | Calm 3.2 s flights (`sine.inOut`) between hosts that need attention (offline, degraded, stale), 12 s each, with a slow orbit; slow orbit of the whole city when all is healthy. "AMBIENT" badge. Esc or grabbing the camera stops it.                                    |
| Audit log panel              | palette                                                | Append-only server trail; refusals and lost connections in the alert accent. States that keystrokes are not recorded.                                                                                                                                                    |
| "DEMO DATA" badge            | `hello.dataMode === 'demo'`                            | Permanent while in demo mode. Covers demo hosts and demo resources alike.                                                                                                                                                                                                |

## Decided (Phase 1 defaults, open to change)

- An offline host with a connection error has **no** 3D marker: the tower stays dark (truth
  first) and the error appears in the HUD in the alert accent.
- Swap has no 3D encoding; it is shown in the HUD only.
