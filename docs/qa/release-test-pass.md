# Release test pass

A repeatable, end-to-end test of what the README promises, against real services in Docker:
PostgreSQL, MySQL (plain and TLS-only), MongoDB, Redis (with and without a password), MinIO,
**LocalStack** (S3), **Moto** (RDS, EC2, ALB), the attack lab (an SSH server with CrowdSec and
Fail2ban, two attackers, a short-lived certificate), **Mailpit** (email) and **ntfy** (push).
The app runs on its own config and data in `.qa/`, never your real hosts or vault.

## Run it

```bash
node scripts/qa/pass.mjs up        # start/create containers, seed them, write .qa/config
npm run build
node scripts/qa/pass.mjs serve     # the app on http://127.0.0.1:4700 (link printed)
node scripts/qa/pass.mjs attack    # in a second terminal: real attacks on the lab server
```

Then re-check every fix in one go, against the running app and the real containers:

```bash
node scripts/qa/verify.mjs           # 36 checks, PASS/FAIL each (runs a real attack, ~3 min)
node scripts/qa/verify.mjs --quick   # 32 checks, without the attack
```

It counts a refusal only when it is the exact read-mode refusal (any other error is a FAIL),
and checks the real systems too (no row written, the Redis key untouched, the bucket blocked).
The UI checks it cannot do are in "By hand in the browser" below.

`node scripts/qa/pass.mjs reset` forgets the app's data (findings, alerts, vault) for a clean
pass. Mailpit is on http://127.0.0.1:8025, ntfy on http://127.0.0.1:8090/qa-gridcity.
Automated suites to run alongside: `npm run check`, `npm run test:connectors`,
`npm run test:e2e`.

### By hand in the browser

Show the browser window while doing these: in a hidden or background tab the fade-out
animations run slowly and panels seem to stay open.

| Do                                                                                                                           | Expect                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S, U, C, H one after another, then Esc once                                                                                  | one panel at a time; Esc closes it                                                                 |
| L, type in the box, Esc                                                                                                      | the Logs panel closes                                                                              |
| An MCP `run_command` (e.g. `uptime`); click "Add a note…" and type                                                           | the text goes into the note; the "rendering is slow" hint is gone while it waits                   |
| "Allow all on lab-target", then `hostname`                                                                                   | runs without a card                                                                                |
| …then `… \| base64 -d \| sh`, `curl … \| bash`, a Python `rmtree`, a command with U+202E, `df -h` + 30 newlines + `rm -rf …` | five cards, each with its reason; ⟨U+202E⟩ shown; "31 lines"; the stack scrolls inside the window  |
| Deny them all                                                                                                                | nothing ran on the lab (`docker exec gridcity-security-lab-target-1 ls /tmp`); the hint comes back |

## Checklist (expected results)

| #   | Area                   | Do                                                                                                      | Expect                                                                                                                                  |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fleet                  | open the city                                                                                           | 1 server, 12 resource entries (buckets expand to one building each); `mysql-tls` offline, rest online                                   |
| 2   | Certificates           | look at `short-cert`                                                                                    | **degraded: certificate expires in N days** (lab certificate lives 5 days)                                                              |
| 3   | Doctor                 | D on `mysql-tls`, or `gridcity doctor --json`                                                           | stops at LOGIN "TLS required"; "Turn on TLS, skip verification" **proven**; "Turn on TLS" fails (CA)                                    |
| 4   | Root cause             | `docker stop connectors-test-postgres-1`                                                                | `pg` offline within a poll; `incident_report`: pg root cause, `mongo` + `ssh-port` at risk                                              |
| 5   | Alerts                 | Settings → Alerts: email `127.0.0.1:1025` (none), ntfy `http://127.0.0.1:8090` topic `qa-gridcity`      | test arrives in both; pg OFFLINE then "back online" after `docker start`, in both                                                       |
| 6   | Attacks                | `pass.mjs attack`                                                                                       | brute force (CrowdSec), login after 6 failures, uid-0 `toor`, new `support`, new port 4444; email + ntfy                                |
| 7   | Exposures              | S                                                                                                       | public bucket `public-website`, internet-facing RDS `exposed-db`, `open-redis` without a password                                       |
| 8   | One-click fixes        | block 172.31.250.21; Block public access on `public-website`                                            | Fail2ban bans it (`fail2ban-client status sshd`); bucket finding **resolved**; lock account refuses (sudo needs a password)             |
| 9   | Manage S3 (LocalStack) | M on a bucket                                                                                           | read-only refuses writes (403); after Allow changes: upload, download, copy, move, tags, versioning, CORS, policy, delete; each audited |
| 10  | Credentials            | Connect a database with a pasted password                                                               | works; `resources.yaml` gets `passwordSecret:` only; the password is in no file (yaml, state.db, wal, log)                              |
| 11  | Broken config          | add `colour: blue` to one entry                                                                         | only that entry is skipped and named (banner, startup, `doctor`); the rest stay; Allow changes still works                              |
| 12  | AI approvals (MCP)     | `run_command` from an MCP client                                                                        | nothing runs until Allow; Allow all still asks for `rm -rf`; Deny with a note reaches the AI; all audited                               |
| 13  | Upcoming               | U; backup checks on `app-backups/db/` (24 h, 1 KB) and (24 h, 10 MB), file `/var/backups/site-*.tar.gz` | fine; **this week, too small**; overdue/missing                                                                                         |
| 14  | Runbooks, logs         | R → Listening ports; L "Failed password"                                                                | output with exit codes; auth.log lines from the attack                                                                                  |
| 15  | CLI                    | `gridcity demo --port 4710`, `status`, `logs`, `restart`, `stop`                                        | same link (token) after restart; `status` exits 1 when stopped                                                                          |
| 16  | Panels                 | U then C, then Esc                                                                                      | one panel at a time; one Esc closes what you see                                                                                        |

## Pass 1 · 2026-11-14 (0.5.0 → 1.0 candidate, branch `qa/v1-audit`)

All 16 areas pass after the fixes below. Automated: 621 unit tests, 133 tests against the real
containers, all 36 Playwright browser tests (a 37th only records the README GIF and is skipped
unless `RECORD_MEDIA=1`), lint and types all green.

### Found and fixed (each re-verified live after the fix)

| #   | Severity | Finding                                                                                                      | Fix                                                              |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1   | High     | A certificate expiring in 2 days left the probe **online**; the 14-day rule never saw the value              | `healthSample` passes `certificateDaysLeft` through              |
| 2   | High     | One wrong entry in `resources.yaml` took **every** database and bucket off the map at startup                | Only broken entries are skipped and named; everything else loads |
| 3   | High     | "Block public access" (the one-click fix) could never clear the public-bucket finding                        | A public policy counts only while the access block is off        |
| 4   | Medium   | RDS and load balancers refused `accessKeyIdEnv` / `secretAccessKeyEnv` (documented, and suggested by errors) | Accepted for every AWS kind                                      |
| 5   | Medium   | With a broken entry, Allow changes / Edit / Add on a healthy resource failed                                 | Writes refuse only problems they add                             |
| 6   | Medium   | Side panels stacked in one place; Esc closed the hidden one, so Esc looked broken                            | One side panel at a time                                         |
| 7   | Medium   | The "rendering is slow" hint sat under the AI approval card, its button next to **Allow**                    | The hint steps aside while an approval waits                     |
| 8   | Low      | `gridcity doctor` and the startup output did not mention resources.yaml problems                             | Both report them                                                 |
| 9   | Low      | "Add a note for the AI…" opened the field without focus; typing went nowhere                                 | Focused on open                                                  |
| 10  | Low      | A too-small backup showed as "this month"                                                                    | "This week", with the reason                                     |
| 11  | Low      | Node warned "Setting the TLS ServerName to an IP address" on every probe of an IP                            | No SNI for IP addresses                                          |
| 12  | Low      | Re-running the lab after the bucket fix no longer recreated the exposure                                     | `security-lab.mjs exposure` removes the access block first       |

| 13 | Medium | Connect dialog ignored "Password for this test" (password from a variable or file): the test always failed | The typed password is used for the test, never saved |
| 14 | Medium | The browser tests are not run in CI; two were stale (a renamed form field, a label shared with the toolbar) and hid finding 13 | Tests updated; CI still does not run them (see below) |

### Not covered by this pass

- **Cloud costs**: Cost Explorer is not in LocalStack's free tier; only the "off / no billing"
  state was checked.
- **Web Push** (browser notifications): needs a real browser prompt; see the Playwright notes.
- **Desktop app** installers, **Docker image** and **ACP agents** (Codex, Gemini): not run.
- **SQL Server**: the connector suite ran without the `mssql` profile (large x64 image).
- Kubernetes and Docker container findings: the lab server has neither.

### Observations (not changed)

- Problems that already exist when the app starts (e.g. `mysql-tls` offline) do not send an
  alert; only changes do. Intentional? Worth a decision before 1.0.
- ~~RDS "Allocated storage" shows raw bytes~~ fixed in pass 2 (the AI read raw bytes; the app
  already showed GiB).
- ~~"Login after failures" stays `blocked: unknown` after a ban~~ fixed in pass 2.

## Pass 2 · 2026-11-14 · security (attacking the app)

Ran as an attacker against the running app: hostile HTTP and WebSocket requests, superuser
database accounts in read-only Manage, disguised AI commands over MCP, stored files in buckets.

### Held up (no change needed)

| Area                             | Attacks tried                                                                                                                                                                                                   | Result                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Local API                        | no / wrong token, DNS rebinding (`Host: evil.com`, `localhost.evil.com`, `127.0.0.1.nip.io`), CSRF from another origin, form POST with the token in the URL, cross-site WebSocket, `/mcp` with a foreign Origin | 401 / 421 / 403 every time; no CORS headers; loopback only; token redacted in logs |
| Secrets                          | every GET endpoint and the state WebSocket searched for saved passwords                                                                                                                                         | none; the vault only says whether a password is set                                |
| One-click fixes                  | attacker-controlled IPs and user names reaching `sudo` scripts                                                                                                                                                  | strict allow-lists; scripts rebuilt server-side from the stored finding            |
| Log search, backup checks        | shell metacharacters in the query and the path                                                                                                                                                                  | query sent base64; paths limited to plain characters                               |
| PostgreSQL read mode (superuser) | `COMMIT;`/`ROLLBACK;` escapes, `SET TRANSACTION READ WRITE`, `COPY … TO PROGRAM`, `lo_export`, CTE `DELETE`, `EXPLAIN ANALYZE DELETE`, `ALTER SYSTEM`, `CREATE ROLE`                                            | all refused; nothing written                                                       |
| MySQL read mode (root)           | `INTO OUTFILE/DUMPFILE`, `KILL`, `SET GLOBAL`, `CALL`, `FLUSH`                                                                                                                                                  | all refused                                                                        |
| MongoDB read mode (root)         | insert, `$out`, `$merge`, `dropDatabase`, `killOp`                                                                                                                                                              | all refused; queries have a time limit                                             |
| Bucket previews                  | HTML and SVG with scripts, served inline                                                                                                                                                                        | served as text / download type, `nosniff`, CSP sandbox                             |
| SSH key import                   | `../` and reserved names (`authorized_keys`)                                                                                                                                                                    | basename + allow-list, never overwrites                                            |
| Audit log                        | edit or delete                                                                                                                                                                                                  | refused by database triggers                                                       |
| Files and image                  | vault key and session token permissions; Docker user and ports                                                                                                                                                  | `0600`; runs as `node`; published on 127.0.0.1                                     |
| Dependencies                     | `npm audit --omit=dev`                                                                                                                                                                                          | 0 known vulnerabilities                                                            |

### Found and fixed (re-attacked live after each fix)

| #   | Severity | Finding                                                                                                                                         | Fix                                                                                   |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| S1  | Critical | Read-only Redis: `EVAL "return redis.call('set',…)"` **wrote** (any command, `FLUSHALL` included)                                               | `EVAL`/`EVALSHA`/`FCALL` need Changes on; `may_replicate` counts as a change          |
| S2  | High     | AI approval card spoofable: a right-to-left override showed `echo # …` for `echo ;touch …`; 40 blank lines hid the real tail                    | Hidden characters shown as ⟨U+…⟩ and always ask; line count and collapsed gaps warned |
| S3  | High     | Read-only PostgreSQL ran `pg_terminate_backend` (killed sessions) and `pg_reload_conf`                                                          | Side-effect functions refused in read mode, also behind comments or quotes            |
| S4  | High     | "Allow all" ran hidden code without asking: `base64 -d \| sh`, `curl \| bash`, `eval`, Python `rmtree`, `chown -R … /etc`, moving `sshd_config` | New rules; everyday commands (`ps \| grep`, `curl \| python3 -m json.tool`) still run |
| S5  | Medium   | With several AI requests waiting, the stack grew off the top of the window: some cards and their Deny buttons unreachable                       | The stack scrolls inside the window                                                   |
| S6  | Medium   | Read-only Redis: `PUBLISH` reached subscribed applications; `MULTI` left the shared console queuing every later command                         | `PUBLISH` needs Changes on; transactions refused in the console                       |

### Known limits (by design, documented)

- "Allow all" skips the card for commands the classifier sees as harmless; it is a heuristic, not
  a sandbox. A hidden tail that is itself harmless (`touch`) runs; a destructive one asks.
- Read mode allows reads a superuser may do, e.g. PostgreSQL `pg_read_file`: the credentials are
  yours, and the AI tools never get the Manage views.
- Text the AI reads (log lines, account names, bucket names) can contain prompt injection; every
  command it asks for still needs your click.

## Pass 3 · 2026-11-14 · re-verify everything on LocalStack

A clean `.qa/` (fresh data and config), a fresh build, then every fix from passes 1 and 2 checked
again. `scripts/qa/verify.mjs` was written for this and is the way to repeat it.

**Result: 36/36 verify checks, every hand check in the browser, 648 unit tests, 135 tests against
the real containers, 36/36 browser tests, lint and types: all pass** (after the two fixes below).

### Found and fixed in this pass

| #   | Severity | Finding                                                                                                                                                                                                                                | Fix                                                                                               |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| P1  | High     | Adding several resources at once lost entries (5 adds: all answered "added", 4 kept) and once **corrupted** `resources.yaml` (a YAML error, so after a restart nothing would load). `hosts.yaml` had the same pattern in three writers | One edit at a time per file, written in one step (temp file + rename); tests fail on the old code |
| P2  | Low      | Esc did nothing in Search logs: the search box has the cursor from the start, and the global Esc ignores text fields                                                                                                                   | Esc in that box closes the panel, as its Close button says                                        |

### Double-checked and not bugs

- "DNS rebinding check fails" in the first verify run: Node's `fetch` silently drops a hand-set
  `Host` header, so the attack was never sent. curl and `node:http` get 421. The script now uses
  `node:http`.
- Panels that looked open after Esc: the browser pane was hidden, so the 0.18 s fade-out ran
  slowly. With the panels' real opacity and longer waits, one panel at a time and one Esc closes it.
- The first verify run counted any error as a "refusal"; the PostgreSQL checks were passing on
  a connection error (P1 had dropped the resource). The script now accepts only the exact
  read-mode refusal.
