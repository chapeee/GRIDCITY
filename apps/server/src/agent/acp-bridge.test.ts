import * as acp from '@agentclientprotocol/sdk';
import type { AgentSession } from '@app/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpBridge, type AgentLauncher } from './acp-bridge';
import type { AgentDefinition } from './agent-catalog';

/**
 * The bridge against a fake ACP agent built with the same official library,
 * connected in-process: what Codex or Gemini CLI would send, without
 * downloading them.
 */

const definition: AgentDefinition = {
  id: 'fake',
  label: 'Fake Agent',
  signIn: 'test',
  command: 'unused',
  args: [],
  unavailableReason: () => null,
};

interface FakeAgentLog {
  newSession?: acp.NewSessionRequest;
  prompts: string[];
  permissions: { title: string; chosen: string }[];
  cancelled: boolean;
}

/** A tiny agent: asks for sign-in once, then answers each prompt with a tool call. */
function fakeAgent(
  log: FakeAgentLog,
  options: { http?: boolean; authAt?: 'session' | 'prompt' } = {},
): AgentLauncher {
  return () => {
    const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
    const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
    let signedIn = false;
    let resolveExit: (reason: string) => void = () => {};

    const app = acp
      .agent({ name: 'fake' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { mcpCapabilities: { http: options.http ?? true } },
        authMethods: [
          { id: 'chatgpt', name: 'Sign in with ChatGPT' },
          // Set up outside the app, so not offered as a button:
          { type: 'env_var', id: 'openai-api-key', name: 'Use OPENAI_API_KEY' } as acp.AuthMethod,
          { id: 'gemini-api-key', name: 'Gemini API key', _meta: { 'api-key': {} } },
        ],
      }))
      .onRequest(acp.methods.agent.authenticate, () => {
        signedIn = true;
        return {};
      })
      .onRequest(acp.methods.agent.session.new, ({ params }) => {
        if (!signedIn && options.authAt !== 'prompt') {
          throw new acp.RequestError(-32000, 'Authentication required');
        }
        log.newSession = params;
        return { sessionId: 'session-1' };
      })
      .onNotification(acp.methods.agent.session.cancel, () => {
        log.cancelled = true;
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        if (!signedIn) throw new acp.RequestError(-32000, 'Authentication required');
        const text = params.prompt
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');
        log.prompts.push(text);
        const update = (u: acp.SessionUpdate) =>
          client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: u,
          });
        await update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Checking ' },
        });
        await update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'the disk.' },
        });

        const ask = async (toolCallId: string, title: string) => {
          await update({ sessionUpdate: 'tool_call', toolCallId, title, status: 'pending' });
          const answer = await client.request(acp.methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: { toolCallId, title },
            options: [
              { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
              { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            ],
          });
          const chosen =
            answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled';
          log.permissions.push({ title, chosen });
          await update({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: chosen === 'yes' ? 'completed' : 'failed',
          });
        };
        await ask('t1', 'example-city: run_command (df -h on web-1)');
        await ask('t2', 'Run ls -la ~/.ssh');
        await update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Disk is at 41%.' },
        });
        return { stopReason: 'end_turn' };
      });
    app.connect({ readable: toAgent.readable, writable: toClient.writable });

    return {
      stream: { readable: toClient.readable, writable: toAgent.writable },
      exited: new Promise((resolve) => (resolveExit = resolve)),
      stop: () => resolveExit('stopped'),
    };
  };
}

let workspaceDir: string;
let log: FakeAgentLog;
beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'acp-bridge-'));
  log = { prompts: [], permissions: [], cancelled: false };
});
afterEach(() => rmSync(workspaceDir, { recursive: true, force: true }));

function makeBridge(launch: AgentLauncher) {
  return new AcpBridge({
    definitions: [definition],
    mcp: { name: 'example-city', url: 'http://127.0.0.1:4600/mcp', token: 'tok' },
    workspaceDir,
    appName: 'Example City',
    version: '0.0.0',
    launch,
  });
}

async function until(bridge: AcpBridge, test: (s: AgentSession) => boolean) {
  for (let i = 0; i < 300; i += 1) {
    if (test(bridge.state)) return bridge.state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out; state: ${JSON.stringify(bridge.state)}`);
}

describe('AcpBridge', () => {
  it('signs in, gives the agent only the app tools, and streams the conversation', async () => {
    const bridge = makeBridge(fakeAgent(log));
    await bridge.start('fake');
    let state = await until(bridge, (s) => s.phase === 'signin');
    expect(state.signInOptions).toEqual([{ id: 'chatgpt', label: 'Sign in with ChatGPT' }]);

    await bridge.signIn('chatgpt');
    await until(bridge, (s) => s.phase === 'ready');
    // The agent reaches servers through the app's MCP endpoint, with the token and its name.
    expect(log.newSession).toEqual({
      cwd: workspaceDir,
      mcpServers: [
        {
          type: 'http',
          name: 'example-city',
          url: 'http://127.0.0.1:4600/mcp',
          headers: [
            { name: 'Authorization', value: 'Bearer tok' },
            { name: 'X-Agent-Client', value: 'Fake Agent' },
          ],
        },
      ],
    });

    await bridge.prompt('Is the disk full on web-1?');
    state = await until(
      bridge,
      (s) => s.phase === 'ready' && s.entries.some((e) => e.text === 'Disk is at 41%.'),
    );

    // The first prompt carries the briefing; the user's words are kept as typed.
    expect(log.prompts[0]).toMatch(/example-city.*list_servers.*run_command/s);
    expect(log.prompts[0]).toMatch(/Is the disk full on web-1\?$/);
    // The app's own tool is let through (the fleet tools ask the user); local actions are refused.
    expect(log.permissions).toEqual([
      { title: 'example-city: run_command (df -h on web-1)', chosen: 'yes' },
      { title: 'Run ls -la ~/.ssh', chosen: 'no' },
    ]);
    const shown = state.entries.map((e) => [e.role, e.text, e.status]);
    expect(shown).toContainEqual(['user', 'Is the disk full on web-1?', null]);
    expect(shown).toContainEqual(['agent', 'Checking the disk.', null]);
    expect(shown).toContainEqual(['tool', 'example-city: run_command (df -h on web-1)', 'done']);
    expect(shown).toContainEqual(['tool', 'Run ls -la ~/.ssh', 'failed']);
    expect(state.entries.some((e) => e.role === 'system' && /Refused "Run ls/.test(e.text))).toBe(
      true,
    );

    await bridge.prompt('Thanks');
    await until(bridge, (s) => s.phase === 'ready' && log.prompts.length === 2);
    expect(log.prompts[1]).toBe('Thanks'); // briefed once only

    bridge.stop();
    expect(bridge.state.phase).toBe('idle');
  });

  it('handles agents that ask for sign-in at the first message (like Codex)', async () => {
    const bridge = makeBridge(fakeAgent(log, { authAt: 'prompt' }));
    await bridge.start('fake');
    await until(bridge, (s) => s.phase === 'ready');
    await bridge.prompt('uptime of web-1?');
    const state = await until(bridge, (s) => s.phase === 'signin');
    expect(state.signInOptions).toEqual([{ id: 'chatgpt', label: 'Sign in with ChatGPT' }]);
    await bridge.signIn('chatgpt');
    await until(bridge, (s) => s.phase === 'ready');
    await bridge.prompt('uptime of web-1?');
    await until(bridge, (s) => s.phase === 'ready' && log.prompts.length === 1);
    expect(log.prompts[0]).toMatch(/^\[Context from Example City\]/); // briefing not lost
    bridge.stop();
  });

  it('refuses an agent that cannot use the app tools', async () => {
    const bridge = makeBridge(fakeAgent(log, { http: false }));
    await bridge.start('fake');
    const state = await until(bridge, (s) => s.phase === 'failed');
    expect(state.message).toMatch(/cannot use the app's server tools/);
  });

  it('reports an agent that exits by itself', async () => {
    let exit: (reason: string) => void = () => {};
    const bridge = makeBridge(() => ({
      stream: { readable: new ReadableStream(), writable: new WritableStream() },
      exited: new Promise((resolve) => (exit = resolve)),
      stop: () => {},
    }));
    void bridge.start('fake');
    exit('exit 1: npm error 404 Not Found');
    const state = await until(bridge, (s) => s.phase === 'failed');
    expect(state.message).toBe('Fake Agent stopped: exit 1: npm error 404 Not Found');
  });

  it('explains an unavailable agent', async () => {
    const bridge = new AcpBridge({
      definitions: [{ ...definition, unavailableReason: () => 'Needs ANTHROPIC_API_KEY.' }],
      mcp: { name: 'x', url: 'http://127.0.0.1/mcp', token: 't' },
      workspaceDir,
      appName: 'X',
      version: '0',
      launch: () => {
        throw new Error('must not launch');
      },
    });
    await bridge.start('fake');
    expect(bridge.state).toMatchObject({ phase: 'failed', message: 'Needs ANTHROPIC_API_KEY.' });
  });
});
