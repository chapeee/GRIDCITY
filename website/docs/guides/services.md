---
title: What runs on your servers
description: 'Service discovery over SSH: ports, containers, failed units, updates and connections.'
---

# What runs on your servers

Every 30 seconds each connected server answers one more read-only script. Nothing is installed.

| Section          | Read with                           | Shown                                        |
| ---------------- | ----------------------------------- | -------------------------------------------- |
| Listening ports  | `ss -lntup` (or `netstat`)          | ports with the process name when visible     |
| Containers       | `docker ps -a` (when this user may) | name, image, state; restarting ones in amber |
| Failed services  | `systemctl --failed`                | listed in amber                              |
| Reboot required  | `/var/run/reboot-required`          | a warning                                    |
| Pending updates  | Ubuntu's update notifier            | total, and security updates in amber         |
| Open connections | `ss -tn state established`          | [topology links](./topology.md)              |
| Own addresses    | `ip -o addr`                        | used to match connections to this server     |

Open a server's panel to see them under **Services**.

## Truth rules

When a tool is missing or not allowed (no Docker, no systemd, Alpine without the update notifier),
the panel says it **could not tell**, never "none". While the server is offline, what runs on it is
unknown.

## Interval

`thresholds.discoveryIntervalMs` in `hosts.yaml` (default 30 000 ms, minimum 5 000).
