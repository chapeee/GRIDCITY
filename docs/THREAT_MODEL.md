# Threat model

Status: **Phase 4**. This document is honest about limits; please open an issue if you
find a gap.

## What this tool does with your SSH access

- It opens SSH connections **from your machine** to the hosts you configure.
- It authenticates with your **ssh-agent** or a **key file path** you configure. It never stores
  private keys, passphrases or passwords; not on disk, not in logs, not in the database.
- On each host it runs **one read-only command** per poll that reads `/proc` files and `df`.
  It installs nothing on the remote host.
- When you open a terminal, it opens an interactive shell (PTY) on the existing connection.
  Anything you type runs with that user's permissions, exactly like `ssh`. The audit log records
  that a session was opened and closed (host, size, duration), never what was typed.

## Assets

| Asset                                | Why it matters                                      |
| ------------------------------------ | --------------------------------------------------- |
| Access to your servers (agent, keys) | Full control of every configured host.              |
| Open terminal sessions               | Live shells on your servers.                        |
| Session token                        | Grants the browser UI, and therefore the terminals. |
| Host inventory and metrics           | Reveals infrastructure layout.                      |

## Trust boundaries

1. **Browser ↔ local server** (127.0.0.1). Other websites in the same browser are untrusted.
2. **Local server ↔ remote hosts** (SSH over the network).
3. **Docker container ↔ host** (when run in Docker).

## Threats and mitigations

| Threat                                                  | Mitigation                                                                                                                                                                                                                   | Status                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Another machine on the LAN connects to the UI           | Bind loopback only; refuse other addresses. Docker publishes on `127.0.0.1` only.                                                                                                                                            | Phase 0 ✅              |
| A malicious website calls the local API (CSRF)          | Every request needs the session token; cookie is `SameSite=Strict`, `HttpOnly`.                                                                                                                                              | Phase 0 ✅              |
| DNS rebinding (attacker domain resolves to 127.0.0.1)   | Requests with a non-localhost `Host` header are rejected (421).                                                                                                                                                              | Phase 0 ✅              |
| Token guessing / timing                                 | 256-bit random token per start; constant-time comparison.                                                                                                                                                                    | Phase 0 ✅              |
| Token leaks into logs                                   | Printed to stdout only; request URLs are redacted in logs (tested).                                                                                                                                                          | Phase 0 ✅              |
| Token left in the URL bar / history                     | Client strips `?token=` with `history.replaceState` on load.                                                                                                                                                                 | Phase 1 ✅              |
| The UI phones home or leaks usage to third parties      | No CDNs, web fonts or analytics: fonts and all assets are bundled. The demo source runs fully in the browser.                                                                                                                | Phase 1 ✅              |
| Cross-site WebSocket hijacking                          | Token required, and `Origin` must be this machine on our port; missing Origin is refused; no CORS at all. Tested over a real socket.                                                                                         | Phase 2 ✅              |
| Man-in-the-middle on SSH                                | Strict, read-only `known_hosts` (hashed entries, `[host]:port`, `@revoked`). Unknown, changed or revoked keys are **refused** with their fingerprint, audited, sent to the UI; nothing runs on that host. Tested end to end. | Phase 2 ✅              |
| Secrets written to disk                                 | Only key _paths_ are stored. Keys are read at connect time and never copied or logged; passphrase-protected key files are refused (use the agent). The database holds no secrets.                                            | Phase 2 ✅              |
| Malformed or hostile remote output                      | Output is size-capped (1 MiB) and parsed by pure, fixture-tested functions; anything unexpected becomes "unknown", and a bad poll is a failed poll (data goes stale), never invented values.                                 | Phase 2 ✅              |
| A website makes the browser change state (import hosts) | Every non-GET request also needs our `Origin`, on top of the token and `SameSite=Strict` cookie.                                                                                                                             | Phase 2 ✅              |
| Audit trail tampering through the app                   | The audit table is append-only at the database level (triggers abort UPDATE and DELETE). It does not protect against someone with direct file access.                                                                        | Phase 2 ✅              |
| Commands beyond metrics run on hosts                    | The poller runs one fixed, read-only script (`/proc`, `df`, `os-release`); it is not built from user or remote input. Interactive shells arrive only with the terminal in Phase 4.                                           | Phase 2 ✅              |
| A website opens a shell on your servers                 | The terminal socket needs the session token and our `Origin`, like the state socket; a host must be connected with a verified key first.                                                                                     | Phase 4 ✅              |
| Oversized PTY requests or floods                        | Terminal sizes are bounded (10–1000 cols, 4–500 rows); frames are capped at 1 MiB; output is paused while the browser is behind.                                                                                             | Phase 4 ✅              |
| Supply-chain compromise of a dependency                 | Lockfile + `npm ci`; install scripts must be explicitly approved (`allowScripts`); small dependency surface.                                                                                                                 | Ongoing                 |
| Agent socket mounted into Docker                        | Opt-in via `compose.ssh.example.yaml`, with the risk stated there: anything controlling the container can use your agent while it runs. `known_hosts` is mounted read-only.                                                  | Phase 2 ✅ (documented) |

## Explicit non-goals and honest limits

- **Keystroke-level command auditing is not claimed.** The audit log records terminal session
  open/close, host and timestamps, plus connection events. Capturing commands typed into a PTY is
  unreliable (shell editing, pasted input, full-screen programs) and is not attempted.
- **Dev mode serves the client code without the token.** The Vite dev server (`npm run dev`)
  serves the web app's static files to anyone on `127.0.0.1`; only `/api` and `/ws` (proxied to
  the server) require the token. The code is open source anyway. Production builds guard every
  request.
- **Not a multi-user tool.** Anyone who can run code as your OS user can read the printed token.
- **No protection against a compromised local machine.** If your machine is compromised, your SSH
  access already is.
