import { toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FleetTools, RunCommandResult } from './fleet-tools';

/** Path of the MCP endpoint. */
export const MCP_PATH = '/mcp';
/** Optional header naming the AI app, shown on approval cards ("Claude Code"). */
export const AGENT_CLIENT_HEADER = 'x-agent-client';
const DEFAULT_CLIENT = 'MCP client';

export interface McpEndpointOptions {
  tools: FleetTools;
  /** Server name the AI sees, from PROJECT_NAME. */
  serverName: string;
  version: string;
}

/**
 * The fleet as an MCP server, for AI apps the user already runs with their
 * own subscription (Claude Code, Claude Desktop, Cursor, Codex...):
 *
 *   claude mcp add --transport http <name> http://127.0.0.1:<port>/mcp \
 *     --header "Authorization: Bearer <token>" --header "X-Agent-Client: Claude Code"
 *
 * Built on the official MCP SDK; it serves both the 2026 protocol and the
 * older stateless HTTP clients. The app-wide guard has already checked the
 * session token (Bearer) and the Host header before a request gets here.
 */
export function registerMcpEndpoint(app: FastifyInstance, options: McpEndpointOptions): void {
  const handler = createMcpHandler((ctx) =>
    buildMcpServer(options, ctx.authInfo?.clientId ?? DEFAULT_CLIENT),
  );

  const serve = async (request: FastifyRequest) => {
    const label = request.headers[AGENT_CLIENT_HEADER];
    const client =
      typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : DEFAULT_CLIENT;
    const webRequest = await toWebRequest(request.raw, request.body);
    return handler.fetch(webRequest, {
      parsedBody: request.body,
      // Pass-through only: the session token was verified by the app guard.
      authInfo: { token: 'session', clientId: client, scopes: [] },
    });
  };

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: MCP_PATH,
    handler: async (request, reply) => reply.send(await serve(request)),
  });
}

/** Turns a command result into what the AI reads. */
export function describeRunResult(result: RunCommandResult): { text: string; isError: boolean } {
  switch (result.state) {
    case 'refused':
      return { text: result.reason, isError: true };
    case 'waiting': {
      const what =
        result.phase === 'asking'
          ? `The user has not answered yet in the app${result.needsInput ? ' (the command needs something only they can type)' : ''}.`
          : 'The user allowed it and the command is still running.';
      return {
        text:
          `${what} Tell the user to look at the approval card for ${result.serverName} in the app, ` +
          `then call wait_for_command with request_id "${result.requestId}" to collect the result. ` +
          'Do not send the same command again.',
        isError: false,
      };
    }
    case 'done': {
      const parts = [`exit code: ${result.exitCode ?? 'unknown'}`];
      if (result.note) parts.push(`note from the user: ${result.note}`);
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
      return { text: parts.join('\n\n'), isError: result.exitCode !== 0 };
    }
  }
}

/** One MCP server instance per request (stateless), bound to the caller's label. */
export function buildMcpServer(options: McpEndpointOptions, client: string): McpServer {
  const server = new McpServer(
    { name: options.serverName, version: options.version },
    {
      instructions: [
        `${options.serverName} shows the user's servers, databases, buckets, probes and load`,
        'balancers as a city, grouped in districts, and runs commands on the servers.',
        'Call list_servers (and list_resources) first to see what exists and how it is doing.',
        'run_command runs a shell command on one server over SSH. The user approves every',
        'command in the app before it runs, so explain why in `reason`, keep commands',
        'focused, and prefer read-only checks before changing anything. If run_command answers',
        '"waiting", tell the user to look at the app and collect the result with wait_for_command.',
        'Never ask the user for passwords in chat: declare `input` and they type it in the app.',
      ].join(' '),
    },
  );

  server.registerTool(
    'list_servers',
    {
      title: 'List servers',
      description:
        'Lists every server in the city with its district, connection, health status, OS, CPU, memory, disk usage and the services found on it.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        { type: 'text', text: JSON.stringify({ servers: options.tools.listServers() }, null, 2) },
      ],
    }),
  );

  server.registerTool(
    'list_resources',
    {
      title: 'List databases, buckets, probes and load balancers',
      description:
        'Lists everything in the city that is not an SSH server: databases, RDS instances, buckets, HTTP/TCP probes and load balancers, with status and the latest metrics. Commands cannot run on these.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ resources: options.tools.listResources() }, null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run a command on a server',
      description:
        'Runs a shell command on one server over its SSH connection and returns the exit code and output. ' +
        'The user sees the exact command and must approve it first; denied commands do not run. ' +
        'No interactive programs (no editors, no prompts); add flags like -y where needed. ' +
        'If the command reads a secret on stdin (sudo password, a token for --password-stdin), ' +
        'declare it in `input`: the user types it in the app and you never see it.',
      inputSchema: z.object({
        server: z.string().describe('Server id or name from list_servers.'),
        command: z
          .string()
          .describe('The shell command, run with the login shell of the server user.'),
        reason: z.string().optional().describe('One sentence for the user: why this command.'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe('Stop the command after this many seconds (default 60).'),
        input: z
          .object({
            prompt: z.string().describe('What to ask the user for, e.g. "registry token".'),
            secret: z.boolean().optional().describe('Hide what the user types (default true).'),
          })
          .optional()
          .describe('Something only the user can type, written to the command on stdin.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const result = await options.tools.runCommand({
        server: input.server,
        command: input.command,
        reason: input.reason,
        timeoutSeconds: input.timeout_seconds,
        input: input.input,
        client,
        signal: ctx.mcpReq.signal,
      });
      const { text, isError } = describeRunResult(result);
      return { content: [{ type: 'text', text }], isError };
    },
  );

  server.registerTool(
    'wait_for_command',
    {
      title: 'Collect a command that was waiting',
      description:
        'Waits for a command that run_command answered "waiting" for (the user had not clicked yet, or it was still running) and returns its result.',
      inputSchema: z.object({
        request_id: z.string().describe('The request_id from the "waiting" answer.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const result = await options.tools.waitForCommand(input.request_id, ctx.mcpReq.signal);
      const { text, isError } = describeRunResult(result);
      return { content: [{ type: 'text', text }], isError };
    },
  );

  return server;
}
