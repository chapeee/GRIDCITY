---
title: Time travel
description: 'Rewind the whole city to any recorded moment and play it back.'
---

# Time travel

Press **T** (or **Ctrl+K → Time travel**). A timeline opens at the bottom and the whole city shows
one moment of the past.

- **Drag** the timeline: every tower shows its CPU pulse, memory bands, fullest disk and traffic as
  they were, and every building its status then.
- **Play** watches the past at 1 minute, 10 minutes or 1 hour per second (the speed button).
- **◀ incident / incident ▶** jump between incidents, which are marked on the track (amber:
  degraded, red: offline). Below the track, the incidents happening at that moment are listed;
  click one to fly to it.
- **Back to live** (or **T** again) returns to live data.

## What it shows, honestly

Replays come from what was really recorded:

| Recorded                                                                    | Shown as                                 |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| 30-second buckets of CPU, memory, load, fullest disk, traffic per server    | the tower's encodings                    |
| Status transitions (online, degraded, offline) of every server and resource | their color                              |
| Nothing at that moment                                                      | unknown (a faint outline), never guessed |

The timeline carries a **REPLAY** badge, and live-only information (such as the root-cause banner)
is hidden, so the past is never mistaken for the present.

## How far back

As long as history is kept: 7 days by default, up to 90 in **Settings → Keep history for**.

## In the demo

The demo has no recorded past, so its replay is generated from the same incidents its history
panel lists, and labelled DEMO DATA like everything else in the demo.
