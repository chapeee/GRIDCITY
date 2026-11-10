# Threat model

Status: **Phase 4**. This document is honest about limits; please open an issue if you
find a gap.

## What this tool does with your SSH access

- It opens SSH connections **from your machine** to the hosts you configure.
- It authenticates with your **ssh-agent** or a **key file path** you configure. It never stores
  private keys, passphrases or passwords; not on disk, not in logs, not in the database. (A
  password typed into "Connect a server" is used once in memory, see below.)
- On each host it runs **one read-only command** per poll that reads `/proc` files and `df`.
  It installs nothing on the remote host.
- When you open a terminal, it opens an interactive shell (PTY) on the existing connection.
  Anything you type runs with that user's permissions, exactly like `ssh`. The audit log records
  that a session was opened and closed (host, size, duration), never what was typed.
- **Only when you use "Connect a server"** (Ctrl+K), and only after you act in that dialog:
  - it shows the server's host key fingerprint and appends it to your `known_hosts` **after you
    confirm it**, exactly like answering "yes" in `ssh`. A host already known with a different key
    is never replaced (that is the man-in-the-middle case): you resolve it with `ssh-keygen -R`;
  - it can create a new ed25519 key in your SSH folder (via `ssh-keygen`; never overwrites a file);
  - it can save a private key file **you upload** (`.pem`, `.ppk`, OpenSSH) into your SSH folder
    (mode 600, never overwriting a different key). PuTTY keys are converted to OpenSSH format.
    Passphrase-protected keys are refused, not decrypted: passphrases are never asked for or kept;
  - it uses the account password **once**, in memory, to append your public key to the server's
    `~/.ssh/authorized_keys` (one fixed script, key on stdin, skipped if already present). The
    password is sent only to a host whose key is already trusted, and is never stored, logged,
    returned in an error or kept by the browser after the attempt.

## What this tool does with your database and cloud access

- It connects **from your machine** to the databases, RDS regions and S3-compatible endpoints in
  `resources.yaml`, with credentials **by reference**: an environment variable or a file you point
  to (read at connect time), or for AWS the standard credential chain or a named profile. Nothing
  secret is written to `resources.yaml`, the database or the logs; the file refuses a `password:`
  key and passwords inside URLs.
- Every connector **reads statistics only**: PostgreSQL in a read-only session
  (`default_transaction_read_only`, statement timeout), MySQL `SHOW` and `information_schema`,
  MongoDB admin read commands, Redis `INFO` and `SLOWLOG GET 1`, SQL Server DMVs with
  `ApplicationIntent=ReadOnly`, SQLite opened read-only and never created, AWS
  `DescribeDBInstances` and `GetMetricData`, S3 `ListBuckets`, `HeadBucket` and `ListObjectsV2`.
  It never reads rows or object contents and never writes. A read-only monitoring user is still
  recommended (the `resources.yaml` template shows the grants); the Redis connector works with an
  ACL of `+info +slowlog|get +ping`.

## Assets

| Asset                                | Why it matters                                               |
| ------------------------------------ | ------------------------------------------------------------ |
| Access to your servers (agent, keys) | Full control of every configured host.                       |
| Open terminal sessions               | Live shells on your servers.                                 |
| Session token                        | Grants the browser UI, and therefore the terminals.          |
| Host inventory and metrics           | Reveals infrastructure layout.                               |
| Database and cloud credentials       | Read access to statistics (and, with a broad user, to data). |

## Trust boundaries

1. **Browser ↔ local server** (127.0.0.1). Other websites in the same browser are untrusted.
2. **Local server ↔ remote hosts** (SSH over the network).
3. **Docker container ↔ host** (when run in Docker).

## Threats and mitigations

| Threat                                                  | Mitigation                                                                                                                                                                                                                                                                                      | Status                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Another machine on the LAN connects to the UI           | Bind loopback only; refuse other addresses. Docker publishes on `127.0.0.1` only.                                                                                                                                                                                                               | Phase 0 ✅              |
| A malicious website calls the local API (CSRF)          | Every request needs the session token; cookie is `SameSite=Strict`, `HttpOnly`.                                                                                                                                                                                                                 | Phase 0 ✅              |
| DNS rebinding (attacker domain resolves to 127.0.0.1)   | Requests with a non-localhost `Host` header are rejected (421).                                                                                                                                                                                                                                 | Phase 0 ✅              |
| Token guessing / timing                                 | 256-bit random token per start; constant-time comparison.                                                                                                                                                                                                                                       | Phase 0 ✅              |
| Token leaks into logs                                   | Printed to stdout only; request URLs are redacted in logs (tested).                                                                                                                                                                                                                             | Phase 0 ✅              |
| Saved session token                                     | Kept in the data folder with mode 600 so the link survives restarts; anyone who can read that file could already read your keys. `--new-token` (or deleting the file) replaces it and signs out every browser.                                                                                  | v0.1 ✅                 |
| A malicious or compromised jump host                    | The bastion's own key is checked strictly; the server's SSH session runs end to end over the tunnel, so its host key is still verified and the bastion sees only encrypted traffic.                                                                                                             | v0.1 ✅                 |
| Token left in the URL bar / history                     | Client strips `?token=` with `history.replaceState` on load.                                                                                                                                                                                                                                    | Phase 1 ✅              |
| The UI phones home or leaks usage to third parties      | No CDNs, web fonts or analytics: fonts and all assets are bundled. The demo source runs fully in the browser.                                                                                                                                                                                   | Phase 1 ✅              |
| Cross-site WebSocket hijacking                          | Token required, and `Origin` must be this machine on our port; missing Origin is refused; no CORS at all. Tested over a real socket.                                                                                                                                                            | Phase 2 ✅              |
| Man-in-the-middle on SSH                                | Strict `known_hosts` (the fleet only reads it) (hashed entries, `[host]:port`, `@revoked`). Unknown, changed or revoked keys are **refused** with their fingerprint, audited, sent to the UI; nothing runs on that host. Tested end to end.                                                     | Phase 2 ✅              |
| Secrets written to disk                                 | Only key _paths_ are stored. Keys are read at connect time and never copied or logged; passphrase-protected key files are refused (use the agent). The database holds no secrets.                                                                                                               | Phase 2 ✅              |
| Malformed or hostile remote output                      | Output is size-capped (1 MiB) and parsed by pure, fixture-tested functions; anything unexpected becomes "unknown", and a bad poll is a failed poll (data goes stale), never invented values.                                                                                                    | Phase 2 ✅              |
| A website makes the browser change state (import hosts) | Every non-GET request also needs our `Origin`, on top of the token and `SameSite=Strict` cookie.                                                                                                                                                                                                | Phase 2 ✅              |
| Audit trail tampering through the app                   | The audit table is append-only at the database level (triggers abort UPDATE and DELETE). It does not protect against someone with direct file access.                                                                                                                                           | Phase 2 ✅              |
| Commands beyond metrics run on hosts                    | The poller runs one fixed, read-only script (`/proc`, `df`, `os-release`); it is not built from user or remote input. Interactive shells arrive only with the terminal in Phase 4.                                                                                                              | Phase 2 ✅              |
| A website opens a shell on your servers                 | The terminal socket needs the session token and our `Origin`, like the state socket; a host must be connected with a verified key first.                                                                                                                                                        | Phase 4 ✅              |
| Oversized PTY requests or floods                        | Terminal sizes are bounded (10–1000 cols, 4–500 rows); frames are capped at 1 MiB; output is paused while the browser is behind.                                                                                                                                                                | Phase 4 ✅              |
| Supply-chain compromise of a dependency                 | Lockfile + `npm ci`; install scripts must be explicitly approved (`allowScripts`); small dependency surface.                                                                                                                                                                                    | Ongoing                 |
| Agent socket / SSH folder mounted into Docker           | Opt-in via `compose.ssh.example.yaml`, with the risk stated there: anything controlling the container can use your agent and read your SSH folder while it runs. The folder is read-write for the setup dialog; `:ro` works if you skip it.                                                     | Phase 2 ✅ (documented) |
| Trusting an impostor during "Connect a server"          | The fingerprint is shown before anything is written, with how to check it on the server. On confirm the key is probed again and must still match; changed or revoked keys are never replaced; nothing is auto-accepted.                                                                         | v0.1 ✅                 |
| Uploaded private key leaks                              | Sent once to the loopback server behind the usual token/cookie/Origin guards; validated (must sign and verify), saved with mode 600, never logged or returned (only the public half comes back); size-capped. Tested.                                                                           | v0.1 ✅                 |
| Password leaks during key installation                  | Password only in request memory; strict host key check first (untrusted host: the password is not sent); errors never contain it; the request body is not logged; the browser clears the field after each attempt. Tested.                                                                      | v0.1 ✅                 |
| An AI agent runs something harmful on a server          | Nothing runs without an approval card showing the exact command, the server and the AI's reason. "Allow all on this server" lasts until the app restarts and can be revoked; unanswered requests are denied after 5 minutes. Every run and denial is audited with who asked. Tested end to end. | v0.1 ✅                 |
| An ACP agent acts on this computer                      | The app offers agents no file system and no terminal, starts them in an empty folder, gives them only the app's MCP tools, and refuses every other permission they ask for. The agents are the user's own tools, installed by `npx` at pinned versions.                                         | v0.1 ✅                 |
| A website or local process calls `/mcp`                 | Needs the session token. Only `/mcp` accepts a Bearer request without an Origin, which a browser can't send (no CORS). A process that can read the token can already read your keys.                                                                                                            | v0.1 ✅                 |
| Prompt injection (server output steers the AI)          | What a command prints goes back to the AI and may contain instructions. The approval card is the control: the AI can only ask, and you decide each command. Prefer "Allow" to "Allow all" on servers that matter.                                                                               | v0.1 (documented)       |
| A website makes the app install keys or trust hosts     | Same guards as every write: session token, `SameSite=Strict` cookie and our `Origin`.                                                                                                                                                                                                           | v0.1 ✅                 |

| Database or cloud passwords stored in config | `resources.yaml` accepts only references (`passwordEnv`, `passwordFile`, `accessKeyIdEnv`/`secretAccessKeyEnv`, an AWS profile). Inline `password`/`secret`/`token` keys and `user:password@` URLs are refused with an explanation. Tested. | v0.2 ✅ |
| Secrets leak through driver error messages | Every connector error goes through `redactSecrets` (known secret values, URL passwords, `password=` pairs) before it reaches logs, the audit log or the browser. Tested with real wrong-password errors. | v0.2 ✅ |
| A connector changes data | Only statistics queries and read-only API calls; PostgreSQL sessions are read-only, SQL Server connects with read-only intent, SQLite opens read-only. Use read-only users regardless: a broad user could read data if this code were changed. | v0.2 ✅ |
| Hostile or huge responses from a database or endpoint | Fixed queries with 5 s timeouts, polls capped at 3 × the interval, bucket listing stops at `maxObjects` (shown as "≥ N"); unexpected values become unknown. | v0.2 ✅ |
| The credential chain picks the wrong AWS account | RDS and S3 use exactly the SDK's chain or the named `profile`; the HUD shows region and endpoint, so a mismatch is visible. Use a dedicated read-only IAM user (`rds:DescribeDBInstances`, `cloudwatch:GetMetricData`, `s3:ListAllMyBuckets`, `s3:ListBucket`). | v0.2 (documented) |

| A website edits hosts.yaml or settings | Edit, Remove and Settings are `PATCH`/`DELETE`/`PUT` requests behind the usual token, `SameSite=Strict` cookie and Origin checks; bodies are strict schemas (unknown fields refused, addresses and auth cannot be changed through Edit). Every change is audited (`host_edited`, `host_removed`, `settings_changed`). | v0.2 ✅ |
| History reveals more than intended | The database keeps averaged metrics and status transitions for the retention you choose (7 days by default), never commands or secrets. Lowering the retention deletes older rows at once. | v0.2 ✅ |

## Explicit non-goals and honest limits

- **Keystroke-level command auditing is not claimed.** The audit log records terminal session
  open/close, host and timestamps, plus connection events. (Commands an AI agent runs are
  recorded, because the app runs them itself with `exec`.) Capturing commands typed into a PTY is
  unreliable (shell editing, pasted input, full-screen programs) and is not attempted.
- **Dev mode serves the client code without the token.** The Vite dev server (`npm run dev`)
  serves the web app's static files to anyone on `127.0.0.1`; only `/api` and `/ws` (proxied to
  the server) require the token. The code is open source anyway. Production builds guard every
  request.
- **Database statistics need grants.** Without `pg_monitor`, `PROCESS`, `clusterMonitor` or
  `VIEW SERVER STATE`, some values (other sessions' slow queries, replica lag) are unknown and shown
  as dashes, never guessed.
- **Not a multi-user tool.** Anyone who can run code as your OS user can read the printed token.
- **No protection against a compromised local machine.** If your machine is compromised, your SSH
  access already is.
