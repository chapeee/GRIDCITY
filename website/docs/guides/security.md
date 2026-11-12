---
title: Security
description: 'See attacks and exposures on your servers and resources: brute force, logins after guessed passwords, new accounts and ports, public buckets, open databases, and what CrowdSec and Fail2ban catch.'
---

# Security: attacks and exposures

GRIDCITY shows **who is attacking what**, right on the building: a pulsing red ring for a serious
attack or exposure, a thin amber ring for a medium one. Press **S** (or the shield in the toolbar)
for the Security panel: every finding, worst first, with what was seen, the attacker's address,
how many times, whether it is blocked, and what to do. With a building focused (or from the
Security box in its HUD), the panel shows only that building; **All servers** switches to the
whole city.

GRIDCITY does not invent its own intrusion detection. It reads what your servers already record and
what proven open-source tools already detect, and shows it where you look anyway. It **catches known
patterns, not every attack**: an empty list is not proof that nothing happened.

## What is checked, with nothing to install

Every minute, on every connected server, over the SSH connection GRIDCITY already has. Everything is
read-only: no software is installed and nothing is changed.

| Finding                         | Severity                         | How it is found                                                |
| ------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| SSH brute force from an address | medium; high at 100+ an hour     | 10 or more failed SSH logins from one address within an hour   |
| Login after failed attempts     | critical                         | an address failed 5+ times, then logged in: a guessed password |
| Login from a new address        | medium; high for root            | an account logs in from an address it never used before        |
| A second root account (uid 0)   | critical                         | any account besides root with user id 0                        |
| New account                     | medium (low if it cannot log in) | an account that appeared after GRIDCITY started watching       |
| New open port                   | medium                           | something new listens on a non-local address                   |
| Refused sudo                    | medium                           | wrong sudo passwords or "not in sudoers" within an hour        |

The first check of a server records its accounts, open ports and login addresses as normal. When
you add an account or start a service on purpose, open the finding and click **Mark as expected**:
it is learned and stays quiet.

GRIDCITY reads the auth log (`/var/log/auth.log` on Debian/Ubuntu, `/var/log/secure` on RHEL) or
the journal. The account GRIDCITY signs in with must be allowed to read it: add it to the `adm`
group on Debian and Ubuntu (`sudo usermod -aG adm <user>`). The Security panel says, per server,
what could not be read and why.

## CrowdSec and Fail2ban

When [CrowdSec](https://www.crowdsec.net) or [Fail2ban](https://github.com/fail2ban/fail2ban) is
installed on a server, GRIDCITY reads what they caught (`cscli alerts`, `cscli decisions`,
`fail2ban-client status`) and shows it on the building. The same attacker seen by several of them is
one finding, marked **blocked** when one of them actually blocks it.

Reading them usually needs root. Allow just those two read commands for GRIDCITY's account, without
a password:

```bash
echo '<user> ALL=(root) NOPASSWD: /usr/bin/cscli, /usr/bin/fail2ban-client' | sudo tee /etc/sudoers.d/gridcity
```

Two things worth knowing:

- A CrowdSec **ban decision only blocks traffic when a bouncer is installed** (for example
  `crowdsec-firewall-bouncer`). Without one, GRIDCITY says "CrowdSec decided to ban it, but nothing
  actually blocks it".
- CrowdSec ignores private addresses (10.x, 172.16-31.x, 192.168.x) by default, so attacks from
  inside your own network do not show up in CrowdSec. GRIDCITY's own log checks still see them.

If you install nothing else, install CrowdSec: it is free, open source, and blocks brute force and
scans once a bouncer is added.

## Vulnerable packages

Every 12 hours GRIDCITY lists each server's installed packages (`dpkg-query`, `rpm` or `apk`,
read-only) and checks them against [OSV.dev](https://osv.dev), the open vulnerability database fed
by Debian, Ubuntu, Alpine, Rocky and Alma security data. One finding per server says how many
packages have known issues and how many can be fixed by updating, with the worst ones by CVSS
score (computed from the published CVSS 3.1 vector). Severity follows the worst issue that has a
fix; known issues without a fix yet are "low".

## Fixing and looking into findings

Findings offer one-click fixes (block the address, lock the account, block public access on a
bucket) and the runbooks that help look into them. See [Investigate and fix](./operations.md).

## Exposures on databases and buckets

Every ten minutes, with the credentials GRIDCITY already has, read-only:

| Finding                                          | Severity | Check                                                                  |
| ------------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| Public bucket                                    | high     | a bucket policy that allows `*` without conditions, or a public ACL    |
| Bucket without a public access block (AWS)       | low      | nothing is public, but one change could expose it                      |
| Database reachable from the whole internet (RDS) | high     | publicly accessible and a security group open to 0.0.0.0/0 on its port |
| Publicly accessible database (RDS)               | medium   | it has a public address, but no group opens it to everyone             |
| Redis without a password                         | high     | Redis answers `PING` with no credentials                               |
| MongoDB without authentication                   | high     | MongoDB lists its databases with no credentials                        |

Reading security groups needs `ec2:DescribeSecurityGroups`; without it GRIDCITY still reports
"publicly accessible" and says the groups could not be read.

## Alerts

High and critical findings are sent to every alert channel that has **Attacks** switched on (email,
Slack, Discord, Telegram, Teams, ntfy, Pushover, Gotify, Apprise, and browser push), the moment they
are found, whether or not anyone has GRIDCITY open. When one ends (the attacker went quiet, the
bucket was made private), an **"Over:"** message follows, so nobody is left believing an attack is
still going on. Medium and low findings are shown, never sent.

## History, time travel and AI agents

- Every finding is kept for the history retention period. In time travel (**T**) the timeline marks
  attacks (red for serious, amber for medium) and lists what was under attack at that moment.
- New, ended and acknowledged findings are written to the audit log.
- AI agents can call the `security_findings` MCP tool: open and ended findings, plus the checks that
  could not run, so an agent never calls a server safe when it could not look.

## Try it: the attack lab

The repository has a lab that attacks a server on purpose, so you can watch detection work:

```bash
node scripts/security-lab.mjs up
```

```bash
node scripts/security-lab.mjs attack
```

```bash
node scripts/security-lab.mjs exposure
```

It starts a Debian SSH server with CrowdSec and Fail2ban and two attacker containers on a private
Docker network, prints the host entry to add to GRIDCITY, then runs a brute force, a guessed
password, backdoor accounts, a new listening port and a port scan (not detected: that needs firewall
logs). `exposure` makes a bucket public on LocalStack and a database public on Moto. Every attack
stays inside the lab network. `node scripts/security-lab.mjs down` removes it.
