# Visual language

> **Rule:** every light, color, pulse and animation maps to exactly one documented data field.
> If an effect is not in this document, it should not exist. Values live in
> [`apps/web/src/design/tokens.ts`](../apps/web/src/design/tokens.ts); this file explains them.

Status: **draft (Phase 0)**. Items marked _open_ need a decision before Phase 1 ships.

## Palette

Derived from the entrance of [myselfraj.com](https://myselfraj.com): a blue-black void, a cyan
"city of light" glow and icy text. At most **three accents**; everything else is neutral.

| Token                 | Value                   | Used for                                    |
| --------------------- | ----------------------- | ------------------------------------------- |
| `accents.online`      | `#8fe3ff`               | Healthy host glow                           |
| `accents.degraded`    | `#ffc22d`               | Host over a threshold; disk arcs over limit |
| `accents.alert`       | `#ff3b30`               | 2D only: errors, host-key refusals          |
| `neutrals.void`       | `#020406`               | Fog, far background                         |
| `neutrals.base`       | `#050708`               | Scene clear color, page background          |
| `neutrals.surface`    | `#0b1316`               | HUD and palette panels                      |
| `neutrals.grid`       | `#0b1f29`               | Floor grid, dark tower volumes              |
| `neutrals.line`       | `rgba(143,227,255,0.2)` | Hairlines, panel borders                    |
| `neutrals.muted`      | `#4d5759`               | Unknown status, stale/frozen elements       |
| `neutrals.text`       | `#d8f3fb`               | Primary text                                |
| `neutrals.textBright` | `#eef9ff`               | Emphasized numbers                          |

## Host encodings (towers)

Tower **geometry is fixed**. Height and shape never change with metrics, so spatial memory stays
stable. Data is expressed through light only.

| Effect                     | Data field                                | Mapping                                                                                                                       | When the field is `null` |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Edge glow color            | `HostState.status`                        | `online` → online accent · `degraded` → degraded accent · `unknown` → faint muted outline · `offline` → none                  | n/a (status always set)  |
| Pulse speed                | `HostState.cpuPercent`                    | Linear, 0 % → 0.2 Hz, 100 % → 2.0 Hz                                                                                          | No pulse                 |
| Memory bands (fill upward) | `HostState.memory.usedBytes / totalBytes` | 10 bands; lit = `round(ratio × 10)`                                                                                           | All bands unlit          |
| Base ring segments         | `HostState.disks[]`                       | One arc per mount (sorted by mount path), each filled by `used / total`; arc uses degraded accent above `diskDegradedPercent` | No ring                  |
| Rising particles           | `Σ HostState.network[].rx + tx` (B/s)     | Log scale: none below 1 KiB/s, max rate (24/s) at 100 MiB/s                                                                   | No particles             |
| Name label                 | `Host.name`                               | Text above the tower                                                                                                          | n/a                      |

### Truth states (override everything above)

| State     | Trigger                               | Look                                                                                     |
| --------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `offline` | `status === 'offline'`                | Dark volume. **No emissive light, no motion.** Label shows `statusReason`.               |
| Stale     | `stale === true`                      | Saturation 15 %, **all motion frozen**, label "last seen _N_ s ago".                     |
| `unknown` | `status === 'unknown'` (never polled) | Faint muted outline, no bands, no pulse, no particles. Reads as "present, not measured". |

An offline or stale server must never look operational.

## World

| Effect          | Driven by             | Notes                                                        |
| --------------- | --------------------- | ------------------------------------------------------------ |
| District        | `Host.district`       | One district per distinct label; floating thin text label.   |
| Tower position  | Persisted layout slot | Not data. Stable across reloads; new hosts take a free slot. |
| Fog, grid floor | none (atmosphere)     | Static; never animated.                                      |

## UI state effects (not data)

These show _what the user is doing_, never host health.

| Effect                  | Trigger                     | Notes                                      |
| ----------------------- | --------------------------- | ------------------------------------------ |
| Camera fly-to (900 ms)  | Focus a host                | `expo.inOut`                               |
| Jack-in dive (< 500 ms) | Enter on a focused host     | Skippable. Chromatic aberration only here. |
| HUD unfold (220 ms)     | Focus a host                |                                            |
| "DEMO DATA" badge       | `hello.dataMode === 'demo'` | Permanent while in demo mode.              |

## Open questions

- _open_ — Should an offline host with a connection **error** get any 3D marker, or is the error
  shown only in the 2D HUD (current draft: 2D only, using the alert accent)?
- _open_ — Swap usage has no 3D encoding yet; it appears in the HUD only.
