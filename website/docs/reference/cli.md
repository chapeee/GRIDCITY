---
title: Command line
description: 'Every gridcity command and option.'
---

# Command line

```text
gridcity                      start with your servers in the background, then open the printed link
gridcity demo                 start with a simulated city (also in the background)
gridcity status               is it running? prints the link again
gridcity stop                 stop the background server
gridcity restart              stop, then start with the same mode and port
gridcity logs [-f]            show the background server's log (-f: follow)
gridcity doctor [--json]      check this machine and every server, database, bucket and probe
gridcity mcp [--json]         connect Claude Code or any MCP app
gridcity add-host user@host   test and add one SSH server
gridcity import-ssh-config    add every host from ~/.ssh/config
gridcity --version
gridcity --help
```

## `gridcity` and `gridcity demo`

| Option         | Meaning                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `--port <n>`   | serve on this port (default 4600; always on `127.0.0.1`)                                              |
| `--open`       | open the link in your default browser                                                                 |
| `--new-token`  | create a new session token: every existing link and browser is signed out                             |
| `--foreground` | stay attached to this terminal (Ctrl+C stops it), for systemd, launchd, Task Scheduler or a container |

The printed link contains the session token and stays valid across restarts.

**It runs in the background.** `gridcity` starts the server and returns: it keeps watching your
servers and sending alerts after you close the terminal. Run `gridcity` again (or
`gridcity status`) to see the link, `gridcity stop` to stop it. Running `gridcity demo` while your
servers are running (or the other way round) asks you to stop first.

The background server writes `server.log` (the previous run's is `server.log.old`) and
`server.json` (pid and port) in the data folder: `%LOCALAPPDATA%gridcity` on Windows,
`~/.local/share/gridcity` elsewhere. The log never contains the token.

It does not start again after a reboot by itself: run `gridcity` once after logging in, or run
`gridcity --foreground` from systemd, launchd or Task Scheduler.

## `gridcity doctor`

Checks this machine (Node, data folder, disk, ssh-agent, `known_hosts`, config files) and every
server and resource, without starting the app. For each target that does not connect it climbs the
connection ladder, explains the cause and tests candidate fixes with real read-only connections.
Nothing is changed.

| Option       | Meaning                                                |
| ------------ | ------------------------------------------------------ |
| `--json`     | machine-readable report (environment and every report) |
| `--only a,b` | only these server or resource ids                      |

Exit code: `0` everything connects, `1` something needs attention, `2` the Doctor itself failed.

```bash
# In CI: fail the job when production is not reachable
gridcity doctor --only orders-db,api-01
```

## `gridcity mcp`

Prints the `claude mcp add` command for Claude Code and the JSON config for other MCP apps, with
your session token. `--json` prints only the JSON. See [AI agents](../guides/ai-agents.md).

## `gridcity add-host`

```bash
gridcity add-host ops@box.lan:2222 --name web-01 --district "Home lab"
```

| Option              | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `--name <name>`     | label on the tower (default: the address)          |
| `--district <name>` | district (default: `default`)                      |
| `--key <path>`      | use this unencrypted key file instead of ssh-agent |
| `--no-test`         | save without testing the connection first          |

## `gridcity import-ssh-config`

Adds every concrete `Host` from `~/.ssh/config` (HostName, User, Port, IdentityFile) to
`hosts.yaml`. Safe to run again: existing hosts are skipped.

## From source

The same commands run as npm scripts: `npm run dev`, `npm run demo`, `npm run add-host -- user@host`,
`npm run import-ssh-config`.
