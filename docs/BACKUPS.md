# Backups & Restore (v1.2)

GRIDCITY backs up the databases, containers, volumes and folders you already connected, to
local disks, S3 or SFTP, and restores them to the same place or somewhere else. Open it with
the **Backups** button at the top right, or press <kbd>B</kbd>.

Nothing new to log in to: a backup reuses what GRIDCITY already has.

| What it needs       | Where it comes from                                                                  |
| ------------------- | ------------------------------------------------------------------------------------ |
| A database login    | The connection in `resources.yaml` (password saved in the vault, an env var or file) |
| A server            | Its SSH connection from `hosts.yaml` (agent or key file, known_hosts checked)        |
| An S3 bucket        | An `s3` connection in `resources.yaml` (its saved access keys)                       |
| An SFTP folder      | The server's SSH connection, over its SFTP subsystem                                 |
| Email / chat alerts | Your alert channels (Settings → Alerts, tick **Backups**)                            |

Adding a server or a storage account from inside the backup screens opens the usual
**Connect** dialogs and the new entry shows up straight away.

## The screens

- **Dashboard**: backup health (and why), active operations with live progress, success and
  failure counts, storage used per destination, the next scheduled runs and recent activity.
- **Discover**: the databases you connected, plus Docker containers (databases inside them are
  recognised by image), Docker volumes and common folders on this machine and on every
  connected server. **Back up…** starts a job with everything filled in.
- **Backup jobs**: what, where to, when, how long to keep, encryption. Run now, edit, remove.
- **History**: every backup with its copies, size, SHA-256, format and full log. Verify,
  restore or delete one.
- **Storage**: destinations. Add, test, edit, remove.
- **Restore**: pick a backup, pick the target, read the plan, type the target's name, restore.
- **Notifications**: what happened, with links to the details.

## Sources

| Source            | How it is backed up                                                                     | Restore                                              | Types                                   |
| ----------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| PostgreSQL        | `pg_dump -Fc` (custom format)                                                           | `pg_restore --clean --if-exists`; creates the DB     | full                                    |
| MySQL / MariaDB   | `mysqldump --single-transaction --routines --triggers --events` (`mariadb-dump`)        | `mysql` into a database (any name)                   | full                                    |
| MongoDB           | `mongodump --archive`, or GRIDCITY's own driver export (BSON records, no tool needed)   | `mongorestore --drop` (with rename) / driver insert  | full                                    |
| Redis / Valkey    | `DUMP` of every key in every database, with its TTL (Redis's own serialization)         | `RESTORE … REPLACE`                                  | full                                    |
| SQLite            | `VACUUM INTO` (consistent while the app writes); `sqlite3 .backup` for files on servers | file replaced, **old file kept** as `.pre-restore-…` | full                                    |
| SQL Server        | `BACKUP DATABASE … WITH CHECKSUM` + `RESTORE VERIFYONLY`, file read from its machine    | `RESTORE DATABASE` (files moved for a new name)      | full, **differential**                  |
| Firebird          | `gbak -b` to stdout                                                                     | `gbak -rep`                                          | full                                    |
| Docker volume     | `tar` in a throwaway `alpine` container with the volume mounted read-only               | into a volume (created if missing)                   | full                                    |
| Docker container  | `docker export` + the container's settings (not its environment: it may hold secrets)   | `docker import` as a new image (nothing replaced)    | full                                    |
| Files and folders | `tar`; changes found by size and modification time                                      | extract; deleted files removed only when asked       | full, **incremental**, **differential** |
| Custom command    | your command's stdout                                                                   | your restore command reads stdin                     | full                                    |

### Where the tool runs

Database tools can run in four ways, chosen per job:

- **GRIDCITY itself**: MongoDB, Redis and local SQLite through the drivers GRIDCITY already
  uses. Nothing to install.
- **A temporary Docker container**: `docker run --rm` of the official image (`postgres:17-alpine`,
  `mysql:8.4`, `mongo:8.0`, `firebirdsql/firebird:5`; set your server's major version). On this
  machine or on a server.
- **Inside the database container**: `docker exec` into the container that runs the database;
  the tool version always matches.
- **Installed**: `pg_dump` and friends installed on this machine or on the server.

"Runs on" is this machine or any connected server. Over SSH the backup streams back through
the existing connection.

**Passwords never appear in a command line.** Locally they are set in the tool's environment.
On a server they are written to a `0600` file under `~/.cache/gridcity/`, read by the shell and
deleted before the tool starts; Docker gets them with `-e NAME` (name only). `mongodump` reads
its password from a temporary `0600` config file written by the shell. Errors and logs are
scrubbed of every secret.

### Incremental and differential

- **Files**: incremental stores what changed since the previous backup; differential, since
  the last full. Changed = new, different size or different modification time. Removed files
  are listed in the manifest. On servers this needs GNU `find` and `tar` (it falls back to full
  backups otherwise, and says so).
- **SQL Server**: differential backups (`WITH DIFFERENTIAL`). In a differential job the full
  backups are real (not `COPY_ONLY`) so they can be the base; in a full-only job they are
  `COPY_ONLY` and do not disturb other backup chains.
- A full backup is taken every _N_ runs (default 7), and whenever the base is missing.
- A restore of an incremental or differential downloads and checks the whole chain first, then
  restores it oldest first.

## Destinations

- **Local**: any folder on the machine GRIDCITY runs on. The default suggestion is
  `<data folder>/backup-storage`, which updates never touch.
- **S3 / S3-compatible**: AWS, DigitalOcean Spaces, MinIO, Cloudflare R2 or any S3 API, through a
  connected storage account. Multipart uploads in 16 MB+ parts.
- **SFTP**: a folder on any connected server.

Browse folders, buckets and prefixes, create folders, name destinations, test them (a small
file is written, read and removed; free space is shown where it can be measured) and pick
several for one job. Each upload is tracked on its own: one destination failing never stops
the others, and the backup is then **partial**.

Uploads go to `<name>.partial` (local, SFTP) or a multipart upload (S3) and only become the
real file when complete. Every copy gets a `<file>.manifest.json` next to it.

Changing a destination's location applies to new backups; existing backups stay where they
were stored and remain restorable. A destination used by a job cannot be removed, and
removing one never deletes files.

## The backup file

```
<job>/<job>-<UTC time>-<type>.<ext>[.gz|.zst][.enc]
<job>/<job>-<UTC time>-<type>.<ext>[.gz|.zst][.enc].manifest.json
```

1. The source's output is counted and compressed (gzip, or zstd on Node 22.15+).
2. **Encryption** (optional): AES-256-GCM, key = scrypt(passphrase, random salt, N=2¹⁵, r=8, p=1).
   File layout: `"GCBK"`, version `0x01`, log₂N, r, p, salt (16 bytes), IV (12 bytes), the
   ciphertext, then the 16-byte GCM tag.
3. The SHA-256 of the stored file is recorded.
4. After each upload the size is checked and, with **Verify each upload** on (default), the file
   is read back and its SHA-256 compared (`sha256sum` on the server for SFTP).

The manifest records the job, type, the backup it builds on, the source and the tool, sizes,
SHA-256, compression and the encryption parameters (never the key or the passphrase).

**Write the passphrase down.** It is kept in GRIDCITY's encrypted vault so scheduled backups
and restores work, but a backup can only be restored on another install with it. Changing it
keeps the old one for the older backups.

To decrypt a file by hand, a short Node script is enough:

```js
// node decrypt.mjs backup.dump.gz.enc 'passphrase' > backup.dump.gz
import { createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [file, pass] = process.argv.slice(2);
const b = readFileSync(file);
const [n, r, p] = [b[5], b[6], b[7]];
const key = scryptSync(pass, b.subarray(8, 24), 32, { N: 2 ** n, r, p, maxmem: 256 * 2 ** 20 });
const d = createDecipheriv('aes-256-gcm', key, b.subarray(24, 36));
d.setAuthTag(b.subarray(b.length - 16));
process.stdout.write(Buffer.concat([d.update(b.subarray(37, b.length - 16)), d.final()]));
```

## Schedules and retention

- Schedules are five-field cron expressions in the server's local time (presets: hourly, every
  6 hours, daily, weekly, monthly). A run missed while GRIDCITY was closed runs once at the
  next start. A job never runs twice at the same time; at most three operations run at once.
- **Retention** keeps a backup when _any_ rule keeps it: the last _N_, one per day / ISO week /
  month for _N_ periods, everything younger than _N_ days. The newest backup and every backup a
  kept one depends on are always kept. **With no rule set nothing is ever deleted.**
- Retention only deletes files GRIDCITY created and recorded, on the destinations it recorded.

## Progress

Progress is honest: a percentage only when the total is really known.

| Stage       | Shown                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Reading     | bytes and speed; `≈%` and remaining time when the source size is known (files, volumes, SQLite); a moving bar otherwise |
| Uploading   | exact % per destination, with speed and remaining time; overall = slowest destination                                   |
| Downloading | exact % (the stored size is known)                                                                                      |
| Validating  | exact % (the original size is known)                                                                                    |
| Restoring   | exact % of the backup data fed to the restore tool                                                                      |

The live log of each operation streams next to it; the full log stays in History.

## Restore

1. Choose a backup (any backup with a healthy copy).
2. Restore to the original place, or somewhere else: another connection of the same kind,
   another database name, folder, volume or server.
3. The plan lists every file of the chain. **Every file is downloaded, its SHA-256 checked,
   decrypted and decompressed into a staging folder before anything is written**; a damaged copy
   is skipped for the next destination that has one.
4. Type the target's name to confirm.
5. After the restore a quick check runs (tables, collections, keys or files counted, SQLite
   `integrity_check`).

SQLite keeps the previous file; Docker containers come back as a new image; files are only
deleted when you tick "Also delete files that were removed". Database restores replace the
objects the backup contains.

## Safety

- **Interrupted backups**: when GRIDCITY stops mid-backup (crash, power loss, update), the next
  start marks it _interrupted_, removes the partial uploads and staging files, and notifies.
  Finished backups are never touched.
- **Deleting**: a job removed in the app keeps its history and files (they can still be
  restored). A single backup is deleted only when you ask, and only if no kept backup depends
  on it.
- **Updates**: jobs, destinations and history live in the app database (migration 5), which
  every update copies to `backups/` first. Backup files live in your destinations; the
  suggested local folder `backup-storage/` in the data folder is never touched by updates.
- Every job change, backup, restore and deletion is in the audit log.

## Notifications

In-app notifications are always on (Notifications tab, and a toast). Email, chat, ntfy,
webhooks and the rest follow your alert channels: tick **Backups** on a channel. Per job:
failures (default on) and successes (default on). Storage errors and finished restores always
go out.

## API

Everything the screens do is a JSON API under `/api/backup/*` (session token and Origin checked
like the rest of the app), with live events at `/api/backup/events` (Server-Sent Events).

## Adding a source or a destination

- **Source**: write one adapter implementing `SourceAdapter` (`apps/server/src/backup/sources/`),
  register it in `sources/index.ts`, add its kind and capabilities to
  `packages/shared/src/backup.ts`.
- **Destination**: implement `DestinationAdapter` in `apps/server/src/backup/destinations.ts`.

## Testing

`apps/server/src/backup/backup.test.ts` covers the engine end to end with real files
(encrypted full + incremental, chain restore, corruption detection, interrupted runs), cron,
retention and the stream format. `backup.integration.test.ts` runs against real services:

```bash
docker compose -f compose.connectors-test.yaml up -d --wait postgres mysql mongo redis minio
BACKUP_TESTS=1 npx vitest run apps/server/src/backup/backup.integration.test.ts
```

It backs up PostgreSQL, MySQL, MongoDB (driver and mongodump), Redis, SQLite (local and over
SSH), a Docker volume and a folder over SSH (full + incremental) to local disk, MinIO and an
SFTP server it starts itself; restores each one somewhere else from S3 or SFTP and checks the
data. `BACKUP_TESTS_MSSQL=1` (with the `mssql` profile) adds SQL Server full + differential, and
`BACKUP_TESTS_FIREBIRD=1` (with a `gc-it-firebird` container) adds Firebird.
