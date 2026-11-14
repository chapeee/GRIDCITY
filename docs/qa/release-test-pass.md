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

`node scripts/qa/pass.mjs reset` forgets the app's data (findings, alerts, vault) for a clean
pass. Mailpit is on http://127.0.0.1:8025, ntfy on http://127.0.0.1:8090/qa-gridcity.
Automated suites to run alongside: `npm run check`, `npm run test:connectors`,
`npm run test:e2e`.

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
containers, all 37 Playwright browser tests, lint and types all green.

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
- RDS "Allocated storage" shows raw bytes (`21474836480 bytes`) instead of `20 GiB`.
- The finding "login after failures" from an address stays `blocked: unknown` after that address
  was banned through the brute-force finding.
