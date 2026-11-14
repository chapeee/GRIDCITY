import {
  AgentClientMessageSchema,
  type AgentChoice,
  type AgentServerMessage,
  type AgentState,
} from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { ensureWebSocketPlugin } from '../http/websocket-plugin';
import type { AcpBridge } from './acp-bridge';
import type { ApprovalGate } from './approvals';
import type { FleetTools } from './fleet-tools';
import { AGENT_CLIENT_HEADER, MCP_PATH } from './mcp-endpoint';

export interface AgentHubOptions {
  gate: ApprovalGate;
  tools: FleetTools;
  bridge: AcpBridge;
  agents: AgentChoice[];
}

/** Coalesces bursts (streamed agent text) into one message per frame or so. */
const BROADCAST_DELAY_MS = 30;

/**
 * The browser side of the AI features: one WebSocket (`/ws/agent`) that
 * carries approvals, the agent panel's conversation and what is running,
 * and takes the user's decisions and prompts.
 */
export class AgentHub {
  private readonly sinks = new Set<(message: AgentServerMessage) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AgentHubOptions) {
    const schedule = () => this.schedule();
    options.gate.onChange(schedule);
    options.tools.onChange(schedule);
    options.bridge.onChange(schedule);
  }

  get state(): AgentState {
    const { gate, tools, bridge, agents } = this.options;
    return {
      agents,
      session: bridge.state,
      approvals: gate.approvals,
      activity: tools.activity,
      trustedHosts: gate.trustedHosts,
    };
  }

  subscribe(sink: (message: AgentServerMessage) => void): () => void {
    this.sinks.add(sink);
    sink({ type: 'state', state: this.state });
    return () => this.sinks.delete(sink);
  }

  /** Applies one message from the browser; invalid messages are ignored. */
  handle(raw: unknown): void {
    const parsed = AgentClientMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    const { gate, bridge } = this.options;
    switch (message.type) {
      case 'decide':
        return gate.decide(message.approvalId, message.decision, {
          note: message.note,
          answer: message.answer,
          remember: message.remember,
        });
      case 'untrust':
        return gate.untrust(message.hostId);
      case 'start':
        return void bridge.start(message.agentId);
      case 'signin':
        return void bridge.signIn(message.methodId);
      case 'prompt':
        return void bridge.prompt(message.text);
      case 'cancel':
        return bridge.cancel();
      case 'stop':
        return bridge.stop();
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.options.bridge.stop();
    this.options.gate.cancelAll();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const message: AgentServerMessage = { type: 'state', state: this.state };
      for (const sink of this.sinks) sink(message);
    }, BROADCAST_DELAY_MS);
  }
}

export interface AgentRoutesOptions {
  hub: AgentHub;
  /** For the "Use Claude Code" instructions. */
  mcp: { name: string; port: number; token: string };
}

/** `GET /ws/agent` and `GET /api/agent/mcp-setup`. Both are behind the session guard. */
export async function registerAgentRoutes(
  app: FastifyInstance,
  { hub, mcp }: AgentRoutesOptions,
): Promise<void> {
  await ensureWebSocketPlugin(app);

  app.get('/ws/agent', { websocket: true }, (socket) => {
    const unsubscribe = hub.subscribe((message) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    });
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      try {
        hub.handle(JSON.parse(data.toString()));
      } catch {
        // not JSON: ignored
      }
    });
    socket.on('close', unsubscribe);
  });

  // The page already holds the token (it came in the link); this hands it
  // back inside the ready-to-paste command, so the user never copies it by hand.
  app.get('/api/agent/mcp-setup', async () => {
    const url = `http://127.0.0.1:${mcp.port}${MCP_PATH}`;
    const header = `Authorization: Bearer ${mcp.token}`;
    return {
      name: mcp.name,
      url,
      claudeCode: `claude mcp add --transport http ${mcp.name} ${url} --header "${header}" --header "${AGENT_CLIENT_HEADER}: Claude Code"`,
      json: {
        mcpServers: {
          [mcp.name]: {
            type: 'http',
            url,
            headers: { Authorization: `Bearer ${mcp.token}`, [AGENT_CLIENT_HEADER]: 'Claude Code' },
          },
        },
      },
    };
  });
}
