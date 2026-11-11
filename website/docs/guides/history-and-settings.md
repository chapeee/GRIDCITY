---
title: History, Settings and Edit
description: 'When was it overloaded or down, how long data is kept, and per-server warnings.'
---

# History, Settings and Edit

## History (H)

**H** opens the history of the focused building, or every incident in the fleet.

- **Incidents:** each period a target was degraded (over a warning threshold) or offline, with its
  reason, start and length, recorded as it happened.
- **Charts:** CPU, memory, fullest disk and traffic over 24 hours, 3, 7 or 30 days. Gaps mean "no
  data", never zero.

To see the whole city at one of those moments, use [time travel](./time-travel.md).

## Settings

**Ctrl+K → Settings…**

| Setting               | Default          | Meaning                                        |
| --------------------- | ---------------- | ---------------------------------------------- |
| Keep history for      | 7 days (1–90)    | metrics and incidents; older rows are deleted  |
| Desktop notifications | off              | [alerts](./alerts.md) in this browser          |
| Webhook               | none             | [alerts](./alerts.md) to Slack, Discord, ntfy… |
| CPU warning           | 90 % for 3 polls | a server turns amber                           |
| Memory warning        | 90 %             |                                                |
| Disk warning          | 90 % (any disk)  |                                                |
| Poll every            | 2 000 ms         | how often each server is measured              |
| Stale after           | 3 polls          | missed polls before data freezes               |

Thresholds are written to `hosts.yaml` (comments kept), so the file stays the source of truth.

## Edit (E)

Focus a server and press **E**: name, district, tags, and **its own** warning thresholds (a database
server that always uses 95 % memory need not be amber). The id never changes.

Resources: name, district, tags, and new credentials. Removing a resource deletes its saved
credentials too.

## Audit log

**Ctrl+K → Open audit log.** Append-only (the database refuses edits and deletions): connections,
host key refusals, terminals opened and closed, servers and resources added or changed, AI commands
run or denied, runbook runs, Doctor fixes applied, alerts sent. Never secrets.
