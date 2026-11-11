---
title: MCP tools
description: 'The tools GRIDCITY gives AI agents over MCP, with their inputs and answers.'
---

# MCP tools

Endpoint: `http://127.0.0.1:4600/mcp` (Streamable HTTP), with `Authorization: Bearer <token>` and an
optional `X-Agent-Client: <your app>` header shown on approval cards. `gridcity mcp` prints both.

| Tool               | Input                                                                                           | Read-only | Answer                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `incident_report`  | none                                                                                            | yes       | healthy/total, root causes (with what each explains and what is at risk), every troubled target     |
| `diagnose`         | `target`: server or resource id or name                                                         | yes¹      | a Doctor report: ladder, diagnoses, fixes with `verified`                                           |
| `get_topology`     | `target` (optional)                                                                             | yes       | all districts and links, or one target's uses, used-by and blast radius                             |
| `list_servers`     | none                                                                                            | yes       | servers: status, OS, CPU, memory, disks, uptime, listening ports, containers, failed units, updates |
| `list_resources`   | none                                                                                            | yes       | databases, buckets, probes, load balancers: status and metrics                                      |
| `list_runbooks`    | none                                                                                            | yes       | runbooks with command, read-only flag and `match`                                                   |
| `run_command`      | `server`, `command`, `reason`, `timeout_seconds` (1–600), `input` {`prompt`, `secret`}, `risky` | no        | exit code, stdout, stderr, the user's note; or _waiting_ with a `request_id`                        |
| `wait_for_command` | `request_id`                                                                                    | yes       | the result of a command that was waiting                                                            |

¹ `diagnose` makes a few read-only connection attempts to prove fixes; it changes nothing.

## run_command, step by step

1. The user sees an approval card with the command, server, reason and client.
2. If they answer within 25 seconds, the tool returns the result (output is trimmed to the first 8 KB
   and last 24 KB).
3. Otherwise it returns _waiting_ and a `request_id`; the AI tells the user to look at the app and
   calls `wait_for_command` later. Unanswered requests are denied after 5 minutes.
4. A denial returns the user's note, if any.

`input` declares a secret the command reads on stdin (a token for `--password-stdin`). The user types
it on the card; it is never returned to the AI and is masked if the command echoes it. A `sudo` by a
non-root user gets an optional password field automatically.

## Example: incident_report

```json
{
  "healthy": 31,
  "total": 36,
  "rootCauses": [
    {
      "id": "orders-db",
      "name": "orders-db",
      "status": "offline",
      "reason": "connect ECONNREFUSED 10.0.4.20:5432",
      "explains": ["lekhix-api", "lekhix-web", "lekhix-alb", "lekhix.com"],
      "atRisk": ["lekhix-scraper"]
    }
  ],
  "troubled": ["…"]
}
```
