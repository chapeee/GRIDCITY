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
  /** Display name the user knows the app by (PROJECT_NAME); defaults to serverName. */
  appName?: string;
}

/**
 * How every AI client (Claude Code in a terminal or the desktop app, Codex,
 * Gemini...) should treat the user. The key split: questions for the user go
 * in the AI's own chat, which works the same in a terminal and an app; only
 * what a command itself reads (a password) goes through the app, so a secret
 * never passes through the AI, and the AI always says when to look at the app.
 */
export function mcpInstructions(appName: string): string {
  return [
    `${appName} shows the user's servers, databases, buckets, probes and load balancers as a city,`,
    'grouped in districts, and runs commands on the servers.',
    'Call list_servers and list_resources first to see what exists and how it is doing.',
    '',
    `Every run_command waits for the user to approve it in ${appName}. Rules:`,
    `1. Before each run_command, tell the user in one short line that it needs their approval in ${appName}`,
    `   (for example: "Approve the disk check on web-1 in ${appName}."). Explain why in \`reason\`.`,
    `2. If a result says WAITING, tell the user right away to check ${appName}, then call`,
    '   wait_for_command with the request_id. Repeat while it says WAITING; never send the command twice.',
    '3. Questions for the user that the command does not read (which server, which option, a go-ahead',
    `   for a plan, missing details) belong in your own chat with the user, not in ${appName}.`,
    '4. Input the command itself reads on stdin that only the user knows (a token for --password-stdin,',
    `   a y/n answer) goes in run_command's \`input\`: ${appName} shows the user a field and pipes the answer`,
    `   to stdin. For sudo by a non-root user ${appName} asks for the password on its own. Never ask the user`,
    '   to paste a password or secret into your chat.',
    '5. Commands get no terminal, so nothing interactive: no `sudo su`, `su`, `sudo -i`, editors, pagers or',
    "   prompts. Use `sudo sh -c '...'` for several root commands, -y flags and --no-pager. A command that",
    '   waits for input gets end-of-file and fails instead of hanging.',
    '6. If the user denied a command or added a note, follow the note. Prefer read-only checks first.',
    '7. Commands cannot run on databases, buckets, probes or load balancers: list_resources gives their',
    '   status. To query a database, run its client (psql, mysql, redis-cli, aws) on a server that reaches it.',
  ].join('\n');
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
export function describeRunResult(
  result: RunCommandResult,
  appName = 'the app',
): { text: string; isError: boolean } {
  switch (result.state) {
    case 'refused':
      return { text: result.reason, isError: true };
    case 'waiting': {
      const collect = `call wait_for_command with request_id "${result.requestId}". Do not send the same command again.`;
      if (result.phase === 'running') {
        return {
          text: `RUNNING: the user allowed it and the command is still running on ${result.serverName}. To get the output, ${collect}`,
          isError: false,
        };
      }
      const what = result.needsInput
        ? 'approve the command and type the input it needs'
        : 'approve or deny the command';
      return {
        text:
          `WAITING for the user in ${appName}: the command on ${result.serverName} has not run yet. ` +
          `Tell the user now: "Please check ${appName} to ${what} on ${result.serverName}." Then ${collect} ` +
          'Do not ask for passwords in chat. Unanswered requests are denied after 5 minutes.',
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
  const appName = options.appName ?? options.serverName;
  const server = new McpServer(
    { name: options.serverName, version: options.version },
    { instructions: mcpInstructions(appName) },
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
        `The user sees the exact command and must approve it in ${appName} first; tell them so in one line before calling. ` +
        'Denied commands do not run. If nobody answers within about 25 seconds it returns WAITING with a request_id: ' +
        `tell the user to check ${appName}, then call wait_for_command. ` +
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
      const { text, isError } = describeRunResult(result, appName);
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
      const { text, isError } = describeRunResult(result, appName);
      return { content: [{ type: 'text', text }], isError };
    },
  );

  return server;
}
