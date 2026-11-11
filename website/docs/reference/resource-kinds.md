---
title: Resource kinds
description: 'Every kind of resource, its fields, what it reads and what turns it amber.'
---

# Resource kinds

All connectors are read-only. Default poll intervals are in brackets.

## Databases

| Kind       | Fields (besides the common ones)                                                                       | Library          |
| ---------- | ------------------------------------------------------------------------------------------------------ | ---------------- |
| `postgres` | `host`, `port` (5432), `user`, `database` (postgres), TLS, `slowQueryMs` (1000)                        | `pg`             |
| `mysql`    | `host`, `port` (3306), `user`, `database`, TLS, `slowQueryMs`                                          | `mysql2`         |
| `mongodb`  | `url` (no password in it), `user`, `authSource`, `tls` (from the URL by default), `tlsVerify`, `tlsCa` | `mongodb`        |
| `redis`    | `host`, `port` (6379), `user`, TLS                                                                     | `ioredis`        |
| `mssql`    | `host`, `port` (1433), `user`, `database` (master), `encrypt` (true), `trustServerCertificate`         | `mssql`          |
| `sqlite`   | `path` (a file on this machine, opened read-only)                                                      | `better-sqlite3` |

**TLS** means `tls` (false), `tlsVerify` (true) and `tlsCa` (a PEM certificate). **Password**:
`passwordSecret` (set by the app), `passwordEnv` or `passwordFile`. Polled every 10 s.

Read-only grants to create:

```sql
-- PostgreSQL
CREATE ROLE monitor LOGIN PASSWORD '…'; GRANT pg_monitor TO monitor;
-- MySQL / MariaDB
CREATE USER 'monitor'@'%' IDENTIFIED BY '…'; GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'monitor'@'%';
-- SQL Server
GRANT VIEW SERVER STATE TO monitor;
```

MongoDB: role `clusterMonitor` on `admin`. Redis ACL: `+info +slowlog|get +ping`.

## AWS and object storage

| Kind           | Fields                                                                                                                      | Reads                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `rds`          | `region`, `instances` (all when omitted), `profile`, keys                                                                   | `DescribeDBInstances` + one `GetMetricData` [60 s]        |
| `s3`           | `provider` (aws, spaces, minio, r2, other), `endpoint`, `region`, `buckets`, `maxObjects` (100 000), `forcePathStyle`, keys | `ListBuckets`, `HeadBucket`, `ListObjectsV2` [5 min]      |
| `loadbalancer` | `region`, `names` (all when omitted), `profile`, keys                                                                       | `DescribeLoadBalancers`, target health, CloudWatch [60 s] |

**Keys**: an access key pair pasted in the app (`accessKeyIdSecret`, `secretAccessKeySecret`), S3's
`accessKeyIdEnv` / `secretAccessKeyEnv`, a `profile` from `~/.aws`, or the standard AWS chain.

IAM: RDS `rds:DescribeDBInstances, cloudwatch:GetMetricData`; S3 `s3:ListAllMyBuckets, s3:ListBucket`;
load balancers `elasticloadbalancing:Describe*, cloudwatch:GetMetricData`.

## Probes

| Kind   | Fields                                                                                                                       | Reads                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `http` | `url`, `method` (GET/HEAD), `expectStatus`, `expectBody`, `followRedirects` (true), `insecure` (false), `timeoutMs` (10 000) | status, time to first byte, total, size, certificate [30 s] |
| `tcp`  | `host`, `port` (443), `tls` (false), `expectBanner`, `timeoutMs` (5 000)                                                     | connect time, first banner line, certificate [30 s]         |

## What turns a resource amber (degraded)

- connections above 90 % of the maximum;
- replica lag above 30 s;
- slow queries for 3 polls in a row;
- cache hit below 90 % (with at least 100 reads in the poll);
- storage above 90 % of a known limit;
- RDS CPU above 90 % for 3 polls;
- probe latency above 1 500 ms, or a certificate expiring within 14 days;
- any unhealthy load balancer target;
- a warning from the connector (replication stopped, instance rebooting, untrusted certificate).

All configurable in `resources.yaml` (`thresholds`, file-wide or per entry). A resource is
**offline** when its poll fails (for probes: refused, timed out, unexpected status, body or banner
mismatch), and **stale** after 3 missed polls of its own interval.
