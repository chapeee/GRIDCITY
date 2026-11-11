import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_CLIENT_HEADER, MCP_PATH } from '../agent/mcp-endpoint';
import { projectSlug, resolveAppPaths } from '../config/app-paths';
import { parseServerEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { loadOrCreateSessionToken } from '../security/session-token';

const USAGE = `Connect an AI app (Claude Code, Cursor, Claude Desktop…) to your city over MCP.

  gridcity mcp           the command for Claude Code, and JSON for other apps
  gridcity mcp --json    the JSON config only

The AI then gets incident_report, diagnose, get_topology, list_servers,
list_resources, list_runbooks and run_command (every command waits for your
approval in the app). The app must be running for the AI to reach it.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  loadEnvFiles();
  process.env.PROJECT_NAME ??= 'GRIDCITY';
  const env = parseServerEnv(process.env);
  const { dataDir } = resolveAppPaths({
    projectName: env.PROJECT_NAME,
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
  });
  // The same token the running app uses (created on first start, kept across restarts).
  const token = loadOrCreateSessionToken(join(dataDir, 'session-token'), { rotate: false });
  const name = projectSlug(env.PROJECT_NAME);
  const url = `http://127.0.0.1:${env.SERVER_PORT}${MCP_PATH}`;
  const json = {
    mcpServers: {
      [name]: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}`, [AGENT_CLIENT_HEADER]: 'Claude Code' },
      },
    },
  };
  if (values.json) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      '',
      '  Claude Code:',
      '',
      `    claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${token}" --header "${AGENT_CLIENT_HEADER}: Claude Code"`,
      '',
      '  Other MCP apps (mcp.json):',
      '',
      JSON.stringify(json, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
      '',
      '  Then ask: "why is the site down?" or "which server is running out of disk?"',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
