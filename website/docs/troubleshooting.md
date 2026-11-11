---
title: Troubleshooting
description: 'Common problems and how to fix them. Start with the Doctor.'
---

# Troubleshooting

**Start with the Doctor.** Press **D** in the app, or run `gridcity doctor`. It checks this machine
and every target, and proves fixes against the real target.

## "Session expired" in the browser

The link's token changed (`--new-token`), or you opened an old bookmark. Open the link the app
printed at start (`docker logs gridcity` in Docker).

## A database says "insecure transport are prohibited"

The server requires TLS. Edit it (E): turn on **Use TLS** and paste the provider's CA certificate.
The Doctor finds this and offers a proven fix.

## "self-signed certificate in certificate chain"

The server's certificate is signed by a private CA (DigitalOcean, Aiven, self-hosted MySQL). Paste
that CA in **CA certificate**, or, if you accept the risk, untick **Verify the certificate**.

## A server stays offline

| The Doctor's ladder says | Do this                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| DNS does not resolve     | check the address; private names only resolve inside their network |
| port refused             | is sshd running on that port? is the address right?                |
| port did not answer      | a firewall or security group drops it: allow this machine's IP     |
| not SSH on that port     | fix the port                                                       |
| host key unknown         | Connect a server → compare and trust the fingerprint               |
| host key CHANGED         | verify with the server owner before trusting it                    |
| keys refused             | load your key (`ssh-add`) or install it (`ssh-copy-id`)            |

## In Docker, nothing on my computer connects

`localhost` in a container is the container. Use `host.docker.internal`.

## The city is slow

Press **Ctrl+K → Enable lite mode** (no bloom, no particles). The app suggests it when frames stay
slow.

## Saved passwords stopped working after moving the data folder

The `vault.key` file did not come along (or `SECRETS_KEY` changed). Restore it, or type the
passwords again (Edit → New password).

## Port 4600 is taken

`gridcity --port 4700`.

## Still stuck

Open an issue with the output of `gridcity doctor --json` (remove anything private).
