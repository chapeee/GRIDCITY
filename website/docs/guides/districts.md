---
title: Districts
description: 'Places in the city that hold any mix of servers, databases, buckets, load balancers and probes.'
---

# Districts

A district is a place in the city: a VPC, a provider account, a region, a rack, a client. It holds
**anything**: EC2 servers next to their RDS instances, bucket and load balancer; a home lab next to
the probes that watch it.

A district exists as soon as something names it:

```yaml
district: AWS Mumbai
```

Set it in any connect form, in **Edit** (E), or in `hosts.yaml` / `resources.yaml`.

## Describing a district

`districts.yaml` (optional) adds what the name alone cannot say:

```yaml title="districts.yaml"
districts:
  - name: AWS Mumbai
    provider: aws # aws | gcp | azure | digitalocean | hetzner | oracle | cloudflare
                  # ovh | linode | vultr | home | onprem | other
    region: ap-south-1
    description: Production VPC: EC2 behind the ALB, RDS and the media bucket.
```

A district listed here but not yet used still appears, empty, so you can lay out the city first.

## The district panel

Click a district's name on the floor, or pick it in **Ctrl+K**. The camera frames it and its panel
opens:

- provider, region and description;
- how many buildings are online, degraded, offline, stale or unknown;
- every member (click one to fly to it);
- links that cross the border (what this district uses elsewhere, and who uses it);
- **R**: run a [runbook](./runbooks.md) on all its servers.

## Layout

Each building keeps its slot in its district forever: adding a server never moves another one, so
your spatial memory stays valid.
