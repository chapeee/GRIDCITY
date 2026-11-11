---
title: Docker
description: 'Run the published image, with Compose, SSH keys and databases on your computer.'
---

# Docker

## Run the image

```bash
docker run -d --name gridcity -p 127.0.0.1:4600:4600 \
  -v gridcity-config:/config -v gridcity-data:/data \
  --add-host host.docker.internal:host-gateway \
  ghcr.io/chapeee/gridcity
docker logs gridcity        # the link with your session token
```

| Path      | Holds                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `/config` | `hosts.yaml`, `resources.yaml`, `districts.yaml`, `runbooks.yaml`                                            |
| `/data`   | database, history, audit log, encrypted credentials, `vault.key`, keys made in the app, trusted fingerprints |

The image runs as the unprivileged `node` user, has a health check (`/healthz`), and is built for
`linux/amd64` and `linux/arm64`.

## Compose, without cloning

```bash
curl -O https://raw.githubusercontent.com/chapeee/GRIDCITY/main/compose.image.yaml
docker compose -f compose.image.yaml up -d
docker compose -f compose.image.yaml logs app
```

## Compose, from a clone

```bash
docker compose up --build
```

This builds the image from your checkout and keeps `./config` on your disk.

## SSH keys in Docker

Keys created or uploaded in **Connect a server** are saved in `/data/ssh`, so restarts and rebuilds
keep them. To use your own `~/.ssh` and ssh-agent instead, copy `compose.ssh.example.yaml` to
`compose.ssh.yaml`, keep your platform's block, then:

```bash
docker compose -f compose.yaml -f compose.ssh.yaml up --build
```

## Databases on your computer

Inside a container, `localhost` is the container. Use `host.docker.internal` to reach a database on
your computer (the commands above map it on Linux too). The Doctor detects this mistake and proves
the fix.

## Backups

Back up the `gridcity-data` volume **including `vault.key`**: without the key, saved passwords
cannot be decrypted and must be typed again. `docker compose down -v` deletes the volume.

## AI agents in a container

Claude Code connects from your machine (`gridcity mcp` or the agent panel shows the command).
Agents started inside the container (Codex, Gemini CLI) cannot open a browser to sign in: give them
an API key (`OPENAI_API_KEY`, `GEMINI_API_KEY`) as an environment variable.
