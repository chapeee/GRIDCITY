import type { Host } from '@app/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../http/create-app';
import { buildAllowedOrigins } from '../security/origin';
import { AuditLog } from '../storage/audit-log';
import { openDatabase } from '../storage/database';
import { ApprovalGate } from './approvals';
import { FleetTools, type FleetAccess } from './fleet-tools';
import { MCP_PATH, registerMcpEndpoint } from './mcp-endpoint';

/**
 * The MCP endpoint as Claude Code uses it: the official MCP client over real
 * HTTP, the session token as a Bearer header, no Origin.
 */

const TOKEN = 'mcp-test-token';
const host: Host = {
  id: 'web-1',
  name: 'web-1',
  address: '10.0.0.5',
  port: 22,
  user: 'ubuntu',
  district: 'AWS',
  tags: ['prod'],
  auth: { method: 'agent' },
};

let app: FastifyInstance;
let url: string;
let gate: ApprovalGate;
let audit: AuditLog;
let executed: string[];

beforeEach(async () => {
  executed = [];
  gate = new ApprovalGate();
  audit = new AuditLog(openDatabase(':memory:'));
  const fleet: FleetAccess = {
    hosts: () => [host],
    states: () => [],
    isConnected: () => true,
    exec: async (_hostId, command) => {
      executed.push(command);
      return { stdout: 'Filesystem  Use%\n/dev/root  41%\n', stderr: '', exitCode: 0 };
    },
    resources: () => [],
    resourceStates: () => [],
    demoMode: () => false,
  };
  const tools = new FleetTools({ fleet, gate, audit });
  app = await createApp({
    projectName: 'Example City',
    version: '0.0.0',
    sessionToken: TOKEN,
    port: 0,
    allowedOrigins: buildAllowedOrigins([4600]),
    programPaths: [MCP_PATH],
    registerRoutes: async (instance) =>
      registerMcpEndpoint(instance, { tools, serverName: 'example-city', version: '0.0.0' }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${MCP_PATH}`;
});

afterEach(async () => {
  gate.cancelAll();
  await app.close();
});

async function connectClient(headers: Record<string, string> = {}) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Agent-Client': 'Claude Code', ...headers },
    },
  });
  await client.connect(transport);
  return client;
}

/** Waits for the approval card, as the user would see it. */
async function nextApproval() {
  for (let i = 0; i < 200; i += 1) {
    const [approval] = gate.approvals;
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('no approval request arrived');
}

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[]).map((part) => part.text).join('\n');

describe('MCP endpoint', () => {
  it('lists the fleet tools and the servers', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'list_resources',
      'list_servers',
      'run_command',
      'wait_for_command',
    ]);

    const result = await client.callTool({ name: 'list_servers', arguments: {} });
    const { servers } = JSON.parse(textOf(result));
    expect(servers).toEqual([
      expect.objectContaining({
        id: 'web-1',
        address: '10.0.0.5',
        user: 'ubuntu',
        connected: true,
      }),
    ]);
    await client.close();
  });

  it('runs a command only after the user allows it, and audits it', async () => {
    const client = await connectClient();
    const call = client.callTool({
      name: 'run_command',
      arguments: { server: 'web-1', command: 'df -h /', reason: 'Check the disk' },
    });

    const approval = await nextApproval();
    expect(approval).toMatchObject({
      hostId: 'web-1',
      command: 'df -h /',
      reason: 'Check the disk',
      client: 'Claude Code',
    });
    expect(executed).toEqual([]); // nothing runs before the click
    gate.decide(approval.id, 'allow');

    const result = await call;
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('exit code: 0');
    expect(textOf(result)).toContain('/dev/root  41%');
    expect(executed).toEqual(['df -h /']);
    expect(audit.recent(5)[0]).toMatchObject({
      kind: 'agent_command_run',
      hostId: 'web-1',
      detail: expect.stringContaining('Claude Code, allowed by you: df -h / → exit 0'),
    });
    await client.close();
  });

  it('tells the AI when the user denies, and runs nothing', async () => {
    const client = await connectClient();
    const call = client.callTool({
      name: 'run_command',
      arguments: { server: 'web-1', command: 'rm -rf /tmp/cache' },
    });
    gate.decide((await nextApproval()).id, 'deny');
    const result = await call;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/denied/);
    expect(executed).toEqual([]);
    expect(audit.recent(1)[0]).toMatchObject({ kind: 'agent_command_denied' });
    await client.close();
  });

  it('explains an unknown server without asking the user', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'run_command',
      arguments: { server: 'nope', command: 'uptime' },
    });
    expect(textOf(result)).toMatch(/no server "nope".*web-1/);
    expect(gate.approvals).toHaveLength(0);
    await client.close();
  });

  it('refuses requests without the token, and web pages from other sites', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401);
    const fromEvilPage = await fetch(url, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' },
      body,
    });
    expect(fromEvilPage.status).toBe(403);
  });
});
