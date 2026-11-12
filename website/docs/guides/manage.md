---
title: Manage databases, Redis and buckets
description: 'Browse tables, run queries, edit rows, inspect Redis keys and manage object storage, read-only until you switch changes on.'
---

# Manage databases, Redis and buckets

Every connected database, Redis and storage account is a full workspace, not just a building with
a status. Focus a building and press **M** (or click **Manage**, or **Ctrl+K → Manage …**).

The Manage view opens **read-only**. To edit, click **Allow changes…** in its header and confirm.
That sets `manage: write` on the resource in `resources.yaml`, and **every change is written to the
audit log** (what and where, never values or secrets). **Back to read-only** removes it again.

Read-only is enforced by the server and by the database itself, not only by the buttons:

| Engine     | How read-only is enforced                                              |
| ---------- | ---------------------------------------------------------------------- |
| PostgreSQL | statements run in a `READ ONLY` transaction that is rolled back        |
| MySQL      | a `READ ONLY` transaction, and statements that change data are refused |
| SQL Server | the batch runs in a transaction that is always rolled back             |
| SQLite     | the file is opened read-only                                           |
| Redis      | commands Redis itself marks as writes (`COMMAND INFO`) are refused     |
| MongoDB    | inserts, replaces, deletes, index changes, `$out` and `$merge` refused |
| Storage    | uploads, deletes, copies and bucket settings refused                   |

## SQL databases: one manager for PostgreSQL, MySQL/MariaDB, SQL Server and SQLite

- **Tables**: pick a database, filter the tree of schemas, tables and views (with row estimates).
- **Data**: page through rows, sort by a column, search every column. With changes on,
  double-click a cell to edit it, use **+ Insert row**, or delete a row (two clicks). A row is found
  by its primary key; edits that would touch more than one row are refused and nothing changes.
- **Structure**: columns (type, null, default, key, comment) and indexes.
- **Relations**: foreign keys from this table and to it; click one to open the other table.
- **DDL**: the table's `CREATE` statement or the view's definition.
- **Query editor**: SQL with completion for your tables and columns, **Ctrl+Enter** to run,
  **Explain**, several statements at once, and a history per database. Results stop at 1000 rows.

## Redis

- **Keys**: `SCAN` with a pattern and a type filter (never `KEYS`). Each type has its own editor:
  strings (with JSON formatting), hashes, lists, sets, sorted sets and streams. Set or remove a TTL,
  rename, delete, or create a key.
- **Console**: any command, like `redis-cli`, with history (↑/↓). Commands Redis marks as dangerous
  (`FLUSHDB`, `KEYS`, `CONFIG`…) ask for confirmation. `MONITOR`, `SUBSCRIBE` and `SELECT` are not
  available here: use the database picker and the Activity tab.
- **Activity**: record `MONITOR` for 3 to 10 seconds (every command from every client), the slow
  log, the busiest commands, and connected clients.
- **Info**: every `INFO` section.

A user restricted by ACLs sees what it may see; the rest is listed as not available.

## MongoDB

- Databases and collections with document counts and sizes.
- **Documents**: filter, sort and fields in Extended JSON (`{"created": {"$gt": {"$date": "…"}}}`),
  paging, and with changes on: edit, insert and delete documents. Types such as dates and
  ObjectIds round-trip unchanged.
- **Aggregate**: run a pipeline (results stop at 500 documents).
- **Indexes**: list, create (unique, sparse, TTL) and drop.
- **Running operations**: what the server is doing right now.

## Object storage: S3, Spaces, MinIO, R2, LocalStack

- Browse buckets and folders; filter a folder; download any file.
- With changes on: upload files (button or drag and drop, with progress), create folders, delete
  files or whole folders, copy, move or rename, edit tags, create and delete buckets.
- Details of a file: size, type, metadata, version, tags, and a preview for images and text.
- **Settings**: region, versioning (enable or suspend), default encryption, public access block,
  ACL, the bucket policy and CORS rules (edit and save as JSON), lifecycle rules.
- **Usage**: size and object count per top-level folder.

Downloads and uploads go through the app, so storage that only this machine can reach
(`localhost`, a Docker network, a VPC endpoint) works too.

## Testing against LocalStack or Moto

AWS RDS and load balancers accept an **API endpoint** under _Advanced_ in the connect dialog, for
VPC endpoints and local AWS emulators. For S3, choose _Other S3-compatible_ and set the endpoint
(for example `http://localhost:4566` for LocalStack).

## Want a dedicated admin tool as well?

The Manage view covers day-to-day work. For deep administration, you can run well-known open-source
tools next to GRIDCITY with `compose.tools.yaml` (Adminer, CloudBeaver, Redis Commander); see
the comments in that file. They have their own logins: GRIDCITY does not share
its saved passwords with them.
