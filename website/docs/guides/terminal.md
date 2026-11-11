---
title: Jack in (terminal)
description: 'A real shell on any server, through the tower.'
---

# Jack in

Focus a server and press **Enter** (or **Jack in** in its panel). The camera dives through the
tower's skin and a full-screen terminal opens on a real shell: an interactive PTY on the SSH
connection the city already holds, rendered with xterm.js.

![A terminal opened on a server](/img/terminal.png)

- Resize the window: the terminal follows.
- **Ctrl+Shift+X** leaves the terminal and surfaces back to the tower. Esc and Ctrl+K belong to the
  shell while you are inside.
- The dive takes under half a second, and any key skips it.

A terminal needs a live connection: an offline or unknown server has no shell to open, and
databases and buckets have none at all.

## What is recorded

The audit log records that a terminal was opened and closed, on which server and when. What you
type inside a PTY is **not** recorded: that is not reliably possible, and GRIDCITY does not claim it.
