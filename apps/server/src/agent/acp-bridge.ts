import * as acp from '@agentclientprotocol/sdk';
import type { AgentEntry, AgentSession } from '@app/shared';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import type { AuditLog } from '../storage/audit-log';
import type { AgentDefinition } from './agent-catalog';

/** A started agent process (or, in tests, an in-process agent). */
export interface LaunchedAgent {
  stream: acp.Stream;
  stop(): void;
  /** Resolves with a reason when the agent exits on its own. */
  exited: Promise<string>;
}

export type AgentLauncher = (definition: AgentDefinition, cwd: string) => LaunchedAgent;

export interface AcpBridgeOptions {
  definitions: readonly AgentDefinition[];
  /** The app's MCP endpoint, which the agent uses to reach the servers. */
  mcp: { name: string; url: string; token: string };
  /** Empty folder the agent starts in (it has no business on this computer). */
  workspaceDir: string;
  appName: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  audit?: AuditLog;
  launch?: AgentLauncher;
}

/** Older entries are dropped so a long session stays light. */
const MAX_ENTRIES = 300;
/** JSON-RPC error code ACP uses for "sign in first". */
const AUTH_REQUIRED = -32000;

/**
 * Runs one ACP agent (Codex, Gemini CLI...) for the agent panel, using the
 * official ACP client library. The agent is the user's own, signed in with
 * their own account; this class only connects it to the app:
 *
 * - It gets the app's MCP endpoint, so it reaches servers only through the
 *   fleet tools, where every command waits for the user's approval.
 * - It gets no file system or terminal on this computer (the client offers
 *   neither), starts in an empty folder, and any permission it asks for
 *   that is not one of the app's tools is refused.
 */
export class AcpBridge {
  private definition: AgentDefinition | null = null;
  private launched: LaunchedAgent | null = null;
  private connection: acp.ClientConnection | null = null;
  private sessionId: string | null = null;
  private authMethods: acp.AuthMethod[] = [];
  private briefed = false;
  private session: AgentSession = idleSession();
  private nextEntry = 0;
  /** The agent message being streamed, until a tool call or a new turn. */
  private openMessage: AgentEntry | null = null;
  private readonly toolEntries = new Map<string, AgentEntry>();
  private planEntry: AgentEntry | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: AcpBridgeOptions) {}

  get state(): AgentSession {
    return { ...this.session, entries: [...this.session.entries] };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts an agent (stopping any other one first). */
  async start(agentId: string): Promise<void> {
    const definition = this.options.definitions.find((d) => d.id === agentId);
    if (!definition) return this.fail(`Unknown agent "${agentId}".`);
    const unavailable = definition.unavailableReason(this.options.env ?? process.env);
    if (unavailable) return this.fail(unavailable);

    this.stop();
    this.definition = definition;
    this.session = { ...idleSession(), agentId, phase: 'starting', message: null };
    this.briefed = false;
    this.addEntry('system', `Starting ${definition.label}… (the first start downloads it)`);

    let launched: LaunchedAgent;
    try {
      mkdirSync(this.options.workspaceDir, { recursive: true });
      launched = (this.options.launch ?? launchProcess)(definition, this.options.workspaceDir);
    } catch (error) {
      return this.fail(`Could not start ${definition.label}: ${(error as Error).message}`);
    }
    this.launched = launched;
    void launched.exited.then((reason) => {
      if (this.launched !== launched) return;
      this.cleanup();
      this.fail(`${definition.label} stopped: ${reason}`);
    });

    const app = acp
      .client({ name: this.options.appName })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        this.answerPermission(params),
      )
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.sessionId === this.sessionId) this.applyUpdate(params.update);
      });
    this.connection = app.connect(launched.stream);
    this.options.audit?.append('agent_started', null, definition.label);

    try {
      const init = await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // Deliberately no file system and no terminal on this computer.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: this.options.appName, version: this.options.version },
      });
      if (!init.agentCapabilities?.mcpCapabilities?.http) {
        this.stop();
        return this.fail(
          `${definition.label} cannot use the app's server tools (it does not support MCP over HTTP).`,
        );
      }
      this.authMethods = init.authMethods ?? [];
      await this.openSession();
    } catch (error) {
      if (this.connection) this.failFrom(error);
    }
  }

  /** Signs in with one of the methods the agent offered, then opens the session. */
  async signIn(methodId: string): Promise<void> {
    const connection = this.connection;
    if (!connection || this.session.phase !== 'signin') return;
    this.update({
      phase: 'starting',
      message: 'Signing in… finish it in the browser window that opens.',
    });
    try {
      await connection.agent.request(acp.methods.agent.authenticate, { methodId });
      if (this.sessionId) {
        // Some agents (Codex) open the session first and ask at the first message.
        this.addEntry('system', 'Signed in. Send your message again.');
        this.update({ phase: 'ready', message: null, signInOptions: [] });
      } else {
        await this.openSession();
      }
    } catch (error) {
      this.failFrom(error);
    }
  }

  /** Sends the user's message. The first one carries a short briefing. */
  async prompt(text: string): Promise<void> {
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (!connection || !sessionId || this.session.phase !== 'ready') return;
    this.openMessage = null;
    this.addEntry('user', text);
    this.update({ phase: 'working', message: null });
    const content = this.briefed ? text : `${this.briefing()}\n\nThe user's request:\n${text}`;
    this.briefed = true;
    try {
      const response = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: content }],
      });
      this.openMessage = null;
      const note = {
        end_turn: null,
        cancelled: 'Stopped.',
        refusal: 'The agent declined this request.',
        max_tokens: 'The agent ran out of room for this answer.',
        max_turn_requests: 'The agent hit its step limit for one request.',
      }[response.stopReason];
      if (note) this.addEntry('system', note);
      if (this.connection === connection) this.update({ phase: 'ready', message: null });
    } catch (error) {
      if (this.connection !== connection) return;
      if ((error as { code?: number }).code === AUTH_REQUIRED) {
        this.briefed = false; // the message never reached the model
        this.askToSignIn();
      } else {
        this.failFrom(error);
      }
    }
  }

  /** Asks the agent to stop the current turn. */
  cancel(): void {
    if (this.connection && this.sessionId && this.session.phase === 'working') {
      void this.connection.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId })
        .catch(() => {});
    }
  }

  /** Stops the agent process. The conversation stays visible. */
  stop(): void {
    if (!this.launched) return;
    const label = this.definition?.label ?? 'agent';
    this.cleanup();
    this.options.audit?.append('agent_stopped', null, label);
    this.update({ phase: 'idle', message: null, signInOptions: [] });
  }

  private cleanup(): void {
    const launched = this.launched;
    this.launched = null;
    this.connection?.close();
    this.connection = null;
    this.sessionId = null;
    launched?.stop();
  }

  private async openSession(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    try {
      const response = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: this.options.workspaceDir,
        mcpServers: [
          {
            type: 'http',
            name: this.options.mcp.name,
            url: this.options.mcp.url,
            headers: [
              { name: 'Authorization', value: `Bearer ${this.options.mcp.token}` },
              { name: 'X-Agent-Client', value: this.definition?.label ?? 'Agent' },
            ],
          },
        ],
      });
      this.sessionId = response.sessionId;
      this.addEntry(
        'system',
        `${this.definition?.label} is ready. Ask it anything about your servers.`,
      );
      this.update({ phase: 'ready', message: null, signInOptions: [] });
    } catch (error) {
      if ((error as { code?: number }).code !== AUTH_REQUIRED) throw error;
      this.askToSignIn();
    }
  }

  private askToSignIn(): void {
    const label = this.definition?.label ?? 'The agent';
    const signInOptions = this.authMethods
      .filter(canSignInFromHere)
      .map((method) => ({ id: method.id, label: method.name }));
    const message =
      signInOptions.length > 0
        ? `${label} needs you to sign in.`
        : `${label} needs you to sign in. Run its login command in a terminal on this computer, then start it again.`;
    this.update({ phase: 'signin', message, signInOptions });
  }

  /**
   * The agent asks before using a tool. The app's own tools are allowed here
   * because the fleet tools ask the user anyway (with the exact command).
   * Anything else would act on this computer, so it is refused.
   */
  private answerPermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const pick = (kinds: acp.PermissionOptionKind[]) =>
      params.options.find((option) => kinds.includes(option.kind));
    if (this.isFleetTool(params.toolCall)) {
      const allow = pick(['allow_once', 'allow_always']);
      if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    this.addEntry(
      'system',
      `Refused "${params.toolCall.title ?? 'a local action'}": agents here work on your servers through the app, not on this computer.`,
    );
    const reject = pick(['reject_once', 'reject_always']);
    return reject
      ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  private isFleetTool(toolCall: acp.ToolCallUpdate): boolean {
    const described = JSON.stringify([toolCall.title, toolCall.name, toolCall.rawInput]);
    return (
      described.includes(this.options.mcp.name) &&
      (described.includes('run_command') || described.includes('list_servers'))
    );
  }

  private applyUpdate(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type !== 'text') return;
        if (this.openMessage) {
          this.openMessage.text += update.content.text;
          this.emit();
        } else {
          this.openMessage = this.addEntry('agent', update.content.text);
        }
        return;
      }
      case 'tool_call': {
        this.openMessage = null;
        const entry = this.addEntry('tool', update.title, toolStatus(update.status));
        this.toolEntries.set(update.toolCallId, entry);
        return;
      }
      case 'tool_call_update': {
        const entry = this.toolEntries.get(update.toolCallId);
        if (!entry) return;
        if (update.title) entry.text = update.title;
        if (update.status) entry.status = toolStatus(update.status);
        this.emit();
        return;
      }
      case 'plan': {
        const text = `Plan:\n${update.entries
          .map((step) => `${step.status === 'completed' ? '✓' : '·'} ${step.content}`)
          .join('\n')}`;
        if (this.planEntry && this.session.entries.includes(this.planEntry)) {
          this.planEntry.text = text;
          this.emit();
        } else {
          this.planEntry = this.addEntry('system', text);
        }
        return;
      }
      default:
        return; // thoughts, modes, usage...: not shown
    }
  }

  private briefing(): string {
    const { appName, mcp } = this.options;
    return [
      `[Context from ${appName}] You are working inside ${appName}, which manages the user's SSH servers.`,
      `Use the "${mcp.name}" MCP tools: list_servers to see the servers and their health,`,
      'and run_command to run shell commands on one of them. The user approves every command,',
      'so say why in `reason`. Do not run commands or edit files on this computer:',
      'the servers are reachable only through those tools. Answer in plain language.',
    ].join(' ');
  }

  private addEntry(
    role: AgentEntry['role'],
    text: string,
    status: AgentEntry['status'] = null,
  ): AgentEntry {
    const entry: AgentEntry = { id: String(this.nextEntry++), role, text, status };
    const entries = [...this.session.entries, entry].slice(-MAX_ENTRIES);
    this.session = { ...this.session, entries };
    this.emit();
    return entry;
  }

  private update(patch: Partial<AgentSession>): void {
    this.session = { ...this.session, ...patch };
    this.emit();
  }

  private failFrom(error: unknown): void {
    const message = (error as Error).message || String(error);
    this.stop();
    this.fail(message);
  }

  private fail(message: string): void {
    this.addEntry('system', message);
    this.update({ phase: 'failed', message, signInOptions: [] });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Sign-in methods the panel can offer as one click: the agent's own login
 * (usually a browser window opens). Methods that need a terminal, an
 * environment variable or a typed API key are set up outside the app; the
 * agent list says which variables each agent reads.
 */
function canSignInFromHere(method: acp.AuthMethod): boolean {
  const type = (method as { type?: string }).type;
  if (type !== undefined && type !== 'agent') return false;
  const meta = method._meta ?? {};
  if ('api-key' in meta || 'gateway' in meta) return false;
  return !/api.?key|vertex|gateway/i.test(`${method.id} ${method.name}`);
}

function idleSession(): AgentSession {
  return { agentId: null, phase: 'idle', message: null, signInOptions: [], entries: [] };
}

function toolStatus(status: acp.ToolCallStatus | null | undefined): AgentEntry['status'] {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'in_progress':
      return 'running';
    default:
      return 'pending';
  }
}

/** Keeps the end of the agent's error output for the failure message. */
const STDERR_TAIL_CHARS = 2000;

/** Starts the agent as a child process speaking ACP over stdin/stdout. */
export function launchProcess(definition: AgentDefinition, cwd: string): LaunchedAgent {
  const isWindows = process.platform === 'win32';
  // npx is a .cmd file on Windows; the arguments are fixed strings from the catalog.
  const child = spawn(definition.command, definition.args, {
    cwd,
    shell: isWindows,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<string>((resolve) => {
    child.on('error', (error) => resolve(error.message));
    child.on('exit', (code, signal) => {
      const last = stderr.trim().split('\n').slice(-3).join(' ').trim();
      resolve(`exit ${code ?? signal}${last ? `: ${last}` : ''}`);
    });
  });
  return {
    stream: acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
    exited,
    stop() {
      if (child.exitCode !== null || child.pid === undefined) return;
      if (isWindows) {
        // Kill the whole tree: cmd.exe -> npx -> the agent.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    },
  };
}
