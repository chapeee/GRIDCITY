import { toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FleetTools } from './fleet-tools';

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

/** One MCP server instance per request (stateless), bound to the caller's label. */
export function buildMcpServer(options: McpEndpointOptions, client: string): McpServer {
  const server = new McpServer(
    { name: options.serverName, version: options.version },
    {
      instructions: [
        `${options.serverName} shows the user's SSH servers as a city and runs commands on them.`,
        'Call list_servers first to see which servers exist and how they are doing.',
        'run_command runs a shell command on one server over SSH. The user approves every',
        'command in the app before it runs, so explain why in `reason`, keep commands',
        'focused, and prefer read-only checks before changing anything.',
      ].join(' '),
    },
  );

  server.registerTool(
    'list_servers',
    {
      title: 'List servers',
      description:
        'Lists every server in the city with its connection, health status, OS, CPU, memory and disk usage.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const servers = options.tools.listServers();
      return {
        content: [{ type: 'text', text: JSON.stringify({ servers }, null, 2) }],
      };
    },
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run a command on a server',
      description:
        'Runs a shell command on one server over its SSH connection and returns the exit code and output. ' +
        'The user sees the exact command and must approve it first; denied commands do not run. ' +
        'No interactive programs (no editors, no prompts); add flags like -y where needed.',
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
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      const result = await options.tools.runCommand({
        server: input.server,
        command: input.command,
        reason: input.reason,
        timeoutSeconds: input.timeout_seconds,
        client,
        signal: ctx.mcpReq.signal,
      });
      if (!result.ran) {
        return { content: [{ type: 'text', text: result.reason }], isError: true };
      }
      const parts = [`exit code: ${result.exitCode ?? 'unknown'}`];
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
      return {
        content: [{ type: 'text', text: parts.join('\n\n') }],
        isError: result.exitCode !== 0,
      };
    },
  );

  return server;
}
