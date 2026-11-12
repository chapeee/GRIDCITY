---
title: Investigate and fix
description: "Fix findings in one click, run the right runbook, see what happened around an incident, search every server's logs, watch containers and pods, and track cloud costs."
---

# Investigate and fix

## One-click fixes

Open a finding (Security or Upcoming). Where GRIDCITY can fix it, a **Fix** row shows:

| Fix                 | For                                         | What runs                                                                     |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Block the address   | brute force and suspicious logins (servers) | `fail2ban-client set sshd banip`, else `cscli decisions add`, else `iptables` |
| Lock the account    | new accounts and extra root accounts        | `usermod -L -e 1 <user>` (unlock with `usermod -U -e '' <user>`)              |
| Block public access | public buckets                              | S3 `PutPublicAccessBlock` with all four settings on                           |

Every fix shows exactly what it runs and needs a second click. Commands go through `sudo -n`:
when the server's sudo wants a password, GRIDCITY never types one; it says so and you run the
command yourself. Every fix is written to the audit log, and the checks run again right away so
the city shows the result. Addresses and account names come from validated findings only; nothing
from a log reaches a shell unchecked.

## Runbooks for a finding

Under each finding on a server, **Look into it** offers the read-only runbooks that help:
recent logins and failures, accounts with power, CrowdSec and Fail2ban status, listening ports,
what fills the disk, pending updates, containers. They open in the runbook panel for that server.

## What happened (incident timeline)

**What happened then** on a finding, or **What happened** in time travel, lists everything
recorded around that moment, in order: status changes, attacks and other findings starting and
ending, commands people and AI agents ran (and fixes), changes to settings and resources,
connections and alerts sent. Choose ±15 minutes to ±3 hours, for one building or all.

## Search logs

Press **L** (or the magnifier). One search runs on every chosen server at once over SSH,
read-only: the journal, the log files in `/var/log`, and the logs of running Docker containers.
Plain text or a regular expression; results come back grouped by server with the match
highlighted. The time range filters journal and container lines exactly; for log files it picks
the files changed in that window. Your search text is sent encoded and never parsed by the
server's shell. Searches (the text, not the results) are written to the audit log.

## Containers and Kubernetes

Every minute, on every server, GRIDCITY reads Docker (`docker inspect`, `docker stats`) and,
where `kubectl` reaches a cluster, the pods. The server's HUD shows CPU, memory and restarts per
container, and pod health. Findings:

| Finding                                                 | Severity |
| ------------------------------------------------------- | -------- |
| A container keeps restarting (crash loop)               | high     |
| A container was killed for using too much memory        | high     |
| A pod in CrashLoopBackOff, ImagePullBackOff, OOMKilled  | high     |
| A container fails its health check                      | medium   |
| A container with a restart policy stopped with an error | medium   |
| A pod Pending for more than 10 minutes                  | medium   |

The account GRIDCITY signs in with needs to be in the `docker` group (or allowed
`sudo -n docker`).

## Cloud costs

Press **C** (or the coin). For every AWS account GRIDCITY is connected to (RDS, a load
balancer, or S3 on AWS), it shows the month so far, the expected total for the month, the services
that cost most, and the last 30 days. When a day costs more than 1.5 times the week before (and at
least 5 of your currency), you get an alert.

**Off until you turn it on**: AWS charges $0.01 per Cost Explorer request. GRIDCITY asks at most
every 6 hours, about $2.40 a month. The saved credentials need `ce:GetCostAndUsage` and
`ce:GetCostForecast`, and Cost Explorer must be enabled in the Billing console.
