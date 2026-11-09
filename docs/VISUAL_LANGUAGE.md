# Visual language

> **Rule:** every light, color, pulse and animation maps to exactly one documented data field.
> If an effect is not in this document, it should not exist. Values live in
> [`apps/web/src/design/tokens.ts`](../apps/web/src/design/tokens.ts); the mapping code is
> [`apps/web/src/world/host-visuals.ts`](../apps/web/src/world/host-visuals.ts) (unit tested).

Status: **Phase 1**. Implemented with demo data.

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

## World

| Effect          | Driven by          | Notes                                                                 |
| --------------- | ------------------ | --------------------------------------------------------------------- |
| District block  | `Host.district`    | One per distinct label, sorted by name; thin outline on the floor.    |
| District label  | `Host.district`    | Name in capitals, floating low in front of the district.              |
| Tower position  | Sticky layout slot | Not data. A host keeps its slot; new hosts take the lowest free slot. |
| Fog, grid floor | none (atmosphere)  | Static; never animated.                                               |
| Bloom, vignette | none (atmosphere)  | Off in lite mode.                                                     |

## 2D layer

| Element         | Driven by                                     | Notes                                                                                              |
| --------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Status dot      | status / staleness                            | Online/degraded: filled accent with glow · offline: dark ring · unknown: dashed ring · stale: grey |
| HUD left border | status / staleness                            | Accent for online/degraded, muted otherwise                                                        |
| HUD frozen look | staleness                                     | Whole panel greyscale, reason reads "Data frozen · last seen _N_ ago"                              |
| Sparklines      | last 90 polls of CPU %, memory %, network B/s | Gaps where values were unknown; status color, grey when stale                                      |
| Disk bars       | disk `used / total`                           | Degraded accent above the disk threshold                                                           |
| Error line      | `HostState.error`                             | Alert accent                                                                                       |

## UI state effects (not data)

These show _what the user is doing_, never host health.

| Effect                  | Trigger                            | Notes                                                                                                                            |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Camera fly-to (900 ms)  | Focus a host (click, Tab, palette) | `expo.inOut`; instant with `prefers-reduced-motion`. Tower is framed left of center to make room for the HUD.                    |
| Return flight (700 ms)  | Escape                             |                                                                                                                                  |
| HUD unfold (220 ms)     | Focus a host                       |                                                                                                                                  |
| Focus ring              | A host is focused                  | Thin neutral (text-bright) ring on the floor just outside the disk ring. Host labels hide while focused; the HUD names the host. |
| Jack-in dive (< 500 ms) | Enter on a focused host            | Phase 4. Skippable. Chromatic aberration only here.                                                                              |
| "DEMO DATA" badge       | `hello.dataMode === 'demo'`        | Permanent while in demo mode.                                                                                                    |

## Decided (Phase 1 defaults, open to change)

- An offline host with a connection error has **no** 3D marker: the tower stays dark (truth
  first) and the error appears in the HUD in the alert accent.
- Swap has no 3D encoding; it is shown in the HUD only.
