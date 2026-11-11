---
title: Command line
description: 'Every gridcity command and option.'
---

# Command line

```text
gridcity                      start with your servers, then open the printed link
gridcity demo                 start with a simulated city
gridcity doctor [--json]      check this machine and every server, database, bucket and probe
gridcity mcp [--json]         connect Claude Code or any MCP app
gridcity add-host user@host   test and add one SSH server
gridcity import-ssh-config    add every host from ~/.ssh/config
gridcity --version
gridcity --help
```

## `gridcity` and `gridcity demo`

| Option        | Meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `--port <n>`  | serve on this port (default 4600; always on `127.0.0.1`)                  |
| `--open`      | open the link in your default browser                                     |
| `--new-token` | create a new session token: every existing link and browser is signed out |

The printed link contains the session token and stays valid across restarts.

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
