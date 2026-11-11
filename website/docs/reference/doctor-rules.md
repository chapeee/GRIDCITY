---
title: Doctor rules
description: 'Every cause the Doctor recognises, the evidence it uses and the fixes it proposes.'
---

# Doctor rules

Each rule reads the error, the connection ladder, the detected provider and whether the app runs in
a container. **Patch** fixes are tried against the real target before being offered.

| Rule                         | Recognises                                                                                                                                                                                | Proposes                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `db.tls-required`            | MySQL `require_secure_transport`, `caching_sha2_password` over plain text, Postgres `no pg_hba.conf entry … no encryption`, Neon/Supabase "SSL required", or a provider that requires TLS | patch `tls: true` (then the certificate step); paste the provider CA                                          |
| `db.tls-unsupported`         | "does not support SSL connections", `wrong version number`                                                                                                                                | patch `tls: false`; enable TLS on the server                                                                  |
| `tls.untrusted-ca`           | self-signed certificate, unable to verify the first certificate / local issuer                                                                                                            | paste the CA; patch `tlsVerify: false` (SQL Server `trustServerCertificate`, HTTP `insecure`), lower security |
| `tls.hostname-mismatch`      | certificate altnames do not match                                                                                                                                                         | use the certificate's hostname                                                                                |
| `tls.expired`                | certificate has expired                                                                                                                                                                   | renew on the server                                                                                           |
| `net.dns`                    | `ENOTFOUND`, `EAI_AGAIN`, missing `mongodb+srv` record, internal names                                                                                                                    | check the name; connect from inside the network                                                               |
| `net.localhost-in-container` | `localhost`/`127.0.0.1` while the app runs in a container                                                                                                                                 | patch `host: host.docker.internal`                                                                            |
| `net.refused`                | `ECONNREFUSED`, a refused port on the ladder                                                                                                                                              | patch the provider's port (DigitalOcean 25060…); check bind address                                           |
| `net.timeout`                | timeouts, unreachable hosts, a port that never answers                                                                                                                                    | allow this machine's IP; connect from inside the network                                                      |
| `auth.rejected`              | access denied, password authentication failed, login failed, Mongo/Atlas bad auth, Redis `WRONGPASS`                                                                                      | re-enter the password; patch `authSource: admin` (MongoDB)                                                    |
| `mysql.host-not-allowed`     | `Host 'x' is not allowed to connect`                                                                                                                                                      | the exact `CREATE USER … @'x'` and `GRANT`                                                                    |
| `db.unknown-database`        | unknown database / database does not exist                                                                                                                                                | patch `database: postgres` / `master`, or none                                                                |
| `pg.role-missing`            | role does not exist                                                                                                                                                                       | `CREATE ROLE … GRANT pg_monitor`                                                                              |
| `db.too-many-connections`    | out of connection slots                                                                                                                                                                   | the query that shows who holds them                                                                           |
| `redis.noauth`               | `NOAUTH`                                                                                                                                                                                  | enter the password                                                                                            |
| `redis.no-password-needed`   | AUTH without a configured password                                                                                                                                                        | patch: do not send a password                                                                                 |
| `stream.reset-tls-mismatch`  | the server hangs up right after connecting, TLS off                                                                                                                                       | patch `tls: true` (possible)                                                                                  |
| `mssql.encryption-required`  | server requires encryption                                                                                                                                                                | patch `encrypt: true`                                                                                         |
| `aws.no-credentials`         | no credentials from any provider                                                                                                                                                          | paste an access key pair                                                                                      |
| `aws.bad-key`                | `InvalidAccessKeyId`, `SignatureDoesNotMatch`, invalid security token                                                                                                                     | re-enter the key pair                                                                                         |
| `aws.region-mismatch`        | wrong region in the authorization header, permanent redirect                                                                                                                              | patch the expected `region`                                                                                   |
| `s3.path-style`              | bucket-subdomain DNS failures on a custom endpoint                                                                                                                                        | patch `forcePathStyle: true`                                                                                  |
| `aws.clock-skew`             | `RequestTimeTooSkewed`                                                                                                                                                                    | sync the clock (`w32tm /resync`, `timedatectl set-ntp true`)                                                  |
| `aws.access-denied`          | `AccessDenied`, not authorized to perform                                                                                                                                                 | the exact read-only actions to grant                                                                          |
| `http.status`                | an unexpected HTTP status                                                                                                                                                                 | explanation by status class; follow redirects; expect the status                                              |
| `ssh.*`                      | host key unknown or changed, keys refused, wrong user, unreachable, not SSH on that port                                                                                                  | platform-specific steps (trust, ssh-add, ssh-copy-id, the user to use)                                        |

When nothing matches, the report still says which rung of the ladder failed, or that the network
path works and the service refused for another reason, with the exact error.

## Settings a patch may change

`tls`, `tlsVerify`, `port`, `host`, `authSource`, `database`, `region`, `forcePathStyle`, `encrypt`,
`trustServerCertificate`, `insecure`, `followRedirects`, `expectStatus`, and removing a password
reference. Nothing else, ever.

## Recognised providers

DigitalOcean Managed Databases, Amazon RDS, Azure Database / Azure SQL, Supabase, Neon, PlanetScale,
Upstash, Amazon ElastiCache, Redis Cloud, MongoDB Atlas and Aiven, with whether they require TLS,
their port and where to download their CA.
