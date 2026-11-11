---
title: Environment variables
description: 'Optional settings for scripted setups. Nothing here is required.'
---

# Environment variables

Nothing here is required: the app works with its defaults and everything is set in the app. These
exist for scripted setups and Docker.

| Variable                                                | Default                       | Meaning                                                               |
| ------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `SERVER_PORT`                                           | `4600`                        | port (also `--port`)                                                  |
| `DATA_MODE`                                             | `real`                        | `real` or `demo` (also `gridcity demo`)                               |
| `CONFIG_DIR`                                            | OS config folder              | where the config files live (`/config` in Docker)                     |
| `DATA_DIR`                                              | OS data folder                | database, history, encrypted credentials (`/data` in Docker)          |
| `SSH_DIR`                                               | `~/.ssh`                      | keys and `known_hosts` the app manages (`/data/ssh` in Docker)        |
| `KNOWN_HOSTS_FILE`                                      | `SSH_DIR/known_hosts`         | the `known_hosts` file the app trusts and writes to                   |
| `SSH_CONFIG_FILE`                                       | `SSH_DIR/config`              | read by the importer                                                  |
| `SECRETS_KEY`                                           | generated `vault.key`         | base64 32-byte key for stored credentials (`openssl rand -base64 32`) |
| `ALERT_WEBHOOK_URL`                                     | none                          | webhook fallback; a webhook saved in Settings takes precedence        |
| `LOG_LEVEL`                                             | `warn` (npm), `info` (source) | `fatal` … `trace`                                                     |
| `PROJECT_NAME`                                          | `GRIDCITY`                    | display name and folder names                                         |
| `HOST`                                                  | `127.0.0.1`                   | bind address; anything but loopback is refused (outside Docker)       |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | none                          | API-key sign-in for agents started in the app                         |

Variables used by a resource entry (`passwordEnv: ORDERS_DB_PASSWORD`, AWS keys) are read from the
environment the app runs in.

When installed from npm, the app does **not** read `.env` files from the folder it is started in.
From a source checkout, `.env.example` and `.env` at the repository root are read (real environment
variables win).
