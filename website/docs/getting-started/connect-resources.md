---
title: Connect databases and more
description: 'Databases, AWS RDS, S3-compatible buckets, HTTP and TCP probes and AWS load balancers.'
---

# Connect databases, buckets, probes and load balancers

Press **Ctrl+K → Connect a database, bucket, probe or balancer…**

1. **Pick the kind.** PostgreSQL, MySQL/MariaDB, MongoDB, Redis/Valkey, SQL Server, SQLite, AWS RDS,
   S3/Spaces/MinIO/R2, an HTTP endpoint, a TCP port or an AWS load balancer.
2. **Fill the form.** Host, port, user. **Paste the password or access keys** directly: they are
   stored encrypted on this machine, never in a config file.
3. **Press Test connection.** One real read-only poll shows what the app can see.
4. If it fails, **the Doctor** shows where the connection breaks, why, and fixes it has already
   proven against your server. **Apply** puts the fix in the form and tests again.
5. **Add to the city.**

## Managed databases are recognised

Type a host such as `…db.ondigitalocean.com`, `…mysql.database.azure.com`, `…supabase.co`,
`…neon.tech`, `…psdb.cloud`, `…upstash.io`, `…mongodb.net` or `…aivencloud.com` and the form says
what that service needs (TLS, its port, its own CA) and sets it in one click.

## TLS

Database forms have three TLS settings:

| Setting                | Meaning                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Use TLS                | Encrypt the connection. Required by most managed databases.                           |
| Verify the certificate | On by default. Checks the server is who it claims to be.                              |
| CA certificate         | Paste the provider's CA (PEM) when it signs with its own, like DigitalOcean or Aiven. |

:::tip The classic "TLS required" error

`Connections using insecure transport are prohibited while --require_secure_transport=ON` means the
server requires TLS. Turn on **Use TLS** and paste the provider's CA certificate. The Doctor finds
this for you, and if you do not have the CA it proves "TLS without verification" works, flagged as
lower security.

:::

## What each kind reads

All connectors only read statistics, never your rows or objects. Use a read-only monitoring user;
each form shows the grant to create.

| Kind                  | Reads                                                             | Building        |
| --------------------- | ----------------------------------------------------------------- | --------------- |
| PostgreSQL            | connections, transactions/s, slow queries, cache hit, replica lag | drum            |
| MySQL / MariaDB       | connections, queries/s, slow queries, buffer pool, replica lag    | drum            |
| MongoDB               | connections, operations/s, cache, replica lag                     | drum            |
| SQL Server            | connections, batches/s, buffer cache, slow requests               | drum            |
| SQLite (a local file) | size, WAL, pages, tables (opened read-only)                       | drum            |
| Redis / Valkey        | clients, commands/s, memory, hit ratio                            | hexagonal prism |
| AWS RDS               | every instance in a region: CPU, connections, storage, IOPS, lag  | caged drum      |
| S3, Spaces, MinIO, R2 | one building per bucket: objects, size, growth                    | warehouse       |
| HTTP endpoint         | status, round trip, redirects, certificate expiry                 | beacon          |
| TCP port              | open or not, connect time, banner, certificate                    | beacon          |
| AWS ALB / NLB         | state, healthy targets, requests/s, response time, 5xx            | gate            |

Full details: [Resource kinds](../reference/resource-kinds.md).

## Editing

Focus the building and press **E**: name, district, tags, a **new password or keys**, or remove it
(which also deletes its saved credentials).
