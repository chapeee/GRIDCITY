---
title: Upcoming
description: 'Certificates and domains that expire, disks that will fill up, and backups that are late: one calendar, with alerts 30, 7 and 1 days ahead.'
---

# Upcoming: what will break if nobody acts

Press **U** (or the calendar in the toolbar). The Upcoming panel lists everything dated, soonest
first: certificates and domains that expire, disks that will fill up, and backups that are due.
What needs attention now is at the top, with what to do.

You are alerted on every channel that hears about **degraded** (email, chat, push…): 30, 7 and
1 days before an expiry or a full disk, and when a backup is late, missing or too small. A
"Resolved" message follows when it is dealt with.

## Certificates

Every HTTPS probe (and TCP probe with TLS) is checked with its own TLS handshake every 30 minutes,
so an expired certificate, which makes the probe itself fail, is still read. Load balancers report
their listeners' certificates.

## Domains

The registration of every domain your probes use (`shop.example.com` → `example.com`) is read
from **RDAP**, the registries' public replacement for WHOIS, through IANA's official directory.
Answers are cached for 12 hours. A few registries (for example `.io`) do not publish over RDAP; the
panel says so instead of guessing.

## Disk-full forecast

For every server, the fullest disk's usage over the last three days is fitted to a straight line:
"`/var` full in about 9 days". A big drop (a cleanup) starts the trend again, a flat disk is "not
filling up", and a forecast needs at least six hours of history.

## Backups

**Upcoming → + Add backup check**: tell GRIDCITY where a backup should appear and how often.

| Where                      | What GRIDCITY checks                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| A file pattern on a server | the newest file matching e.g. `/var/backups/db-*.sql.gz` (over SSH, `stat`) |
| A prefix in a bucket       | the newest object under e.g. `nightly/`                                     |

| Finding   | When                                                     | Severity                      |
| --------- | -------------------------------------------------------- | ----------------------------- |
| Missing   | nothing matches                                          | high                          |
| Late      | the newest backup is older than "expected every"         | medium; high at twice as late |
| Too small | smaller than "at least" (an empty dump is a failed dump) | medium                        |

For a nightly job, "every 26 hours" gives it two hours of slack. Checks run every 10 minutes and
right after you save one.
