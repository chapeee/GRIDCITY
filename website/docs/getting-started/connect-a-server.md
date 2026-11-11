---
title: Connect a server
description: 'Add SSH servers in the app (trust, key, password once), from ~/.ssh/config, or by hand.'
---

# Connect a server

Every SSH server becomes a **tower**. GRIDCITY keeps one SSH connection per server and runs one
small read-only script on it every two seconds: it reads `/proc`, `df` and `/etc/os-release`.
Nothing is installed on the server.

## In the app

Press **Ctrl+K → Connect a server…** (or the button in the empty city).

| Where the server is                | What you need                       | User name                                   |
| ---------------------------------- | ----------------------------------- | ------------------------------------------- |
| AWS (EC2, Lightsail), Oracle Cloud | the key file (`.pem`/`.ppk`)        | found for you (`ubuntu`, `ec2-user`, `opc`) |
| Google Cloud                       | your key, pasted in the console     | the one you type                            |
| Azure, DigitalOcean, Hetzner, VPS  | the key you chose, or the password  | `azureuser` / `root` by default             |
| Your own server                    | the password once                   | yours                                       |
| Behind a bastion                   | the key, plus the jump host address | per server                                  |

1. **Trust.** The app reads the server's host key fingerprint. Compare it with the console or
   dashboard and confirm; it is added to your `known_hosts`, like answering "yes" in `ssh`. A key
   that **changed** is never trusted automatically: it could be an attack.
2. **Key.** Pick a key from your ssh-agent or SSH folder, **upload** a key file (AWS `.pem`, PuTTY
   `.ppk` converted for you, OpenSSH `id_*`), or create a new one. **Copy public key** gives you the
   line for a provider console.
3. **Install.** If the server does not accept the key yet, type the account password once. The
   app adds your public key to `authorized_keys`. The password is never saved or logged.
4. **Done.** The server is saved to `hosts.yaml` and its tower lights up.

## From `~/.ssh/config`

**Ctrl+K → Import hosts from ~/.ssh/config**, or:

```bash
gridcity import-ssh-config
```

Every concrete `Host` entry (not wildcards) is added. Safe to run again.

## From the command line

```bash
gridcity add-host ops@203.0.113.10 --name web-01 --district Hetzner
```

The connection is tested with the fleet's exact checks first, and saved only if it works.

## Editing and removing

Focus a server and press **E**: rename it, move it to another district, set tags and its own
warning thresholds, or remove it. The id never changes, so its place in the city and its history
are kept.

## By hand

```yaml title="hosts.yaml"
hosts:
  - id: web-01
    name: web-01
    address: 203.0.113.10
    user: ops
    district: Hetzner
    tags: [web, prod]
    dependsOn: [orders-db] # drawn as a link in the city
```

The running app reloads the file when it changes. See [Configuration](../reference/configuration.md).

## If it does not connect

Focus the server and press **D**. The Doctor checks DNS, the port and the SSH banner, runs the real
connection test and tells you exactly what to do. See [The Doctor](../guides/doctor.md).
