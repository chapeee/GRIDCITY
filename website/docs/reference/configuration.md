---
title: Configuration files
description: 'hosts.yaml, resources.yaml, districts.yaml and runbooks.yaml.'
---

# Configuration files

You never have to edit these: everything can be set up in the app, which writes them for you
(keeping your comments). They exist so you can version, review or script your city. The running app
reloads each file when it changes; an invalid edit keeps the last valid version running and shows
the errors.

Each file is created with a commented example on first start, in the config folder
(`~/.config/gridcity`, `%APPDATA%\gridcity`, or `/config` in Docker).

## hosts.yaml

```yaml
hosts:
  - id: web-01 # stable: a-z, 0-9, - and _; place and history follow it
    name: web-01 # label on the tower
    address: 203.0.113.10
    port: 22 # optional
    user: ops
    district: Hetzner # optional; one district per value
    tags: [web, prod] # optional; runbooks and the palette use them
    auth: # optional, default: ssh-agent
      method: keyFile # agent | keyFile
      path: ~/.ssh/id_ed25519 # a path; the key is never copied
    jump: # optional bastion (like ProxyJump)
      address: bastion.example.com
      user: ops
    thresholds: # optional, this server's own warnings
      memoryDegradedPercent: 97
    dependsOn: [orders-db] # optional, drawn as links

thresholds: # optional, defaults shown
  pollIntervalMs: 2000
  staleAfterPolls: 3
  discoveryIntervalMs: 30000
  cpuDegradedPercent: 90
  cpuDegradedPolls: 3
  memoryDegradedPercent: 90
  diskDegradedPercent: 90
```

## resources.yaml

Every entry has `kind`, `id`, and optionally `name`, `district`, `tags`, `pollIntervalMs`,
`thresholds` and `dependsOn`. Kind-specific fields are listed in
[Resource kinds](./resource-kinds.md).

```yaml
resources:
  - kind: postgres
    id: orders-db
    host: db.internal
    user: monitor # GRANT pg_monitor TO monitor;
    passwordSecret: orders-db.password # pasted in the app, stored encrypted
    tls: true
  - kind: mysql
    id: shop-db
    host: shop.db.ondigitalocean.com
    port: 25060
    user: monitor
    passwordEnv: SHOP_DB_PASSWORD # or: from an environment variable
    tls: true
    tlsCa: |
      -----BEGIN CERTIFICATE-----
      …
      -----END CERTIFICATE-----
  - kind: http
    id: shop-health
    url: https://shop.example.com/healthz
    expectStatus: 200
    district: Edge
    dependsOn: [shop-lb]

thresholds: # optional, defaults shown
  staleAfterPolls: 3
  connectionsDegradedPercent: 90
  replicationLagDegradedSeconds: 30
  slowQueryDegradedPolls: 3
  cacheHitDegradedPercent: 90
  storageDegradedPercent: 90
  cpuDegradedPercent: 90
  cpuDegradedPolls: 3
  latencyDegradedMs: 1500
  certificateDegradedDays: 14
```

**Secrets are refused in this file**: a `password:`, `secret:`, `token:` key or a password inside a
URL is an error. Use the app (stored encrypted, `passwordSecret`), `passwordEnv` or `passwordFile`.

## districts.yaml

```yaml
districts:
  - name: AWS Mumbai
    provider: aws
    region: ap-south-1
    description: Production VPC.
```

See [Districts](../guides/districts.md).

## runbooks.yaml

```yaml
runbooks:
  - id: restart-nginx
    name: Restart nginx
    description: Reload, or restart if the reload fails.
    command: sudo -n systemctl reload nginx || sudo -n systemctl restart nginx
    readOnly: false
    timeoutSeconds: 60
    match: { tags: [web] }
```

See [Runbooks](../guides/runbooks.md).
