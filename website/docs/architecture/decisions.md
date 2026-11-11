---
title: Design decisions
description: 'Why GRIDCITY is built the way it is.'
---

# Design decisions

**Local first, outbound only.** Your SSH access and database credentials never leave your machine.
There is no account to create and no service to trust. The cost: the app must be running to watch
your fleet (Docker with `restart: unless-stopped` makes that easy).

**Nothing installed on servers.** One read-only shell script over the SSH connection you already
trust. No agent to deploy, update or secure.

**Fixed geometry, data as light.** A tower never grows or moves with load, so you learn where things
are and notice when the light changes. Every encoding is documented; an effect that is not
documented does not exist.

**Truth over comfort.** Unknown is unknown, offline is dark, stale freezes, demo and replay are
labelled. See [Truth first](../concepts/truth-first.md).

**Prove before suggesting.** The Doctor could have been a lookup table of error messages. It also
tries its suggestions against the real target, because a confident wrong fix costs more time than
no fix.

**Credentials in the app, encrypted.** Asking people to edit `.env` files to connect a database is a
barrier, so pasted credentials are stored encrypted locally, with environment variables and files
still available for those who manage secrets elsewhere. SSH private keys are still never stored.

**The world is a map, never a gate.** Every action is in the command palette, so the 3D city
helps and never blocks.

**AI behind a gate.** AI agents use the same tools as you, and every command waits for a click. The
app stores no vendor login.

**One protocol, typed both ends.** Every message between server and browser is a zod schema in
`packages/shared`, versioned; a stale tab is told to reload instead of misreading data.

The original brief and its dated amendments are in
[`docs/BRIEF.md`](https://github.com/chapeee/GRIDCITY/blob/main/docs/BRIEF.md).
