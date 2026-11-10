import type { AgentActivity, Host, HostState } from '@app/shared';
import type { ExecResult } from '../ssh/host-connection';
import type { AuditLog } from '../storage/audit-log';
import type { ApprovalGate } from './approvals';

/** What the tools need from the running fleet. */
export interface FleetAccess {
  hosts(): readonly Host[];
  states(): HostState[];
  isConnected(hostId: string): boolean;
  exec(hostId: string, command: string, timeoutMs: number): Promise<ExecResult>;
  /** Demo data has no real servers to run commands on. */
  demoMode(): boolean;
}

export interface FleetToolsOptions {
  fleet: FleetAccess;
  gate: ApprovalGate;
  audit?: AuditLog;
}

/** A server as an AI sees it: enough to choose one, nothing secret. */
export interface ServerSummary {
  id: string;
  name: string;
  address: string;
  user: string;
  district: string;
  tags: string[];
  connected: boolean;
  status: string;
  statusReason: string | null;
  os: string | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  disks: string[];
  uptimeHours: number | null;
}

export interface RunCommandInput {
  /** Server id or name. */
  server: string;
  command: string;
  reason?: string;
  timeoutSeconds?: number;
  /** Who asks (shown on the approval card and in the audit log). */
  client: string;
  signal?: AbortSignal;
}

export type RunCommandResult =
  | { ran: true; serverId: string; exitCode: number | null; stdout: string; stderr: string }
  | { ran: false; reason: string };

export const MAX_COMMAND_CHARS = 10_000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;
/** Output handed back to the AI: the start and the end, which is where errors are. */
const OUTPUT_HEAD_CHARS = 8_000;
const OUTPUT_TAIL_CHARS = 24_000;

/**
 * The fleet, as tools an AI can call. Shared by the MCP endpoint (Claude
 * Code and other MCP clients) and the ACP agent panel, so both follow the
 * same rules: every command waits for the user's approval, runs over the
 * server's existing SSH connection, and lands in the audit log.
 */
export class FleetTools {
  private readonly running = new Map<number, AgentActivity>();
  private nextRun = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: FleetToolsOptions) {}

  listServers(): ServerSummary[] {
    const states = new Map(this.options.fleet.states().map((state) => [state.hostId, state]));
    return this.options.fleet
      .hosts()
      .map((host) => summarize(host, states.get(host.id), this.options.fleet.isConnected(host.id)));
  }

  async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    const { fleet, gate, audit } = this.options;
    if (fleet.demoMode()) {
      return {
        ran: false,
        reason: 'The app is showing demo data; there are no real servers to run commands on.',
      };
    }
    const command = input.command.trim();
    if (!command) return { ran: false, reason: 'The command is empty.' };
    if (command.length > MAX_COMMAND_CHARS) {
      return { ran: false, reason: `The command is longer than ${MAX_COMMAND_CHARS} characters.` };
    }
    const host = findHost(fleet.hosts(), input.server);
    if (!host) {
      const known =
        fleet
          .hosts()
          .map((h) => h.id)
          .join(', ') || 'none';
      return { ran: false, reason: `There is no server "${input.server}". Servers: ${known}.` };
    }
    if (!fleet.isConnected(host.id)) {
      return {
        ran: false,
        reason: `${host.name} is not connected right now, so nothing can run on it.`,
      };
    }

    const outcome = await gate.request(
      {
        hostId: host.id,
        hostName: host.name,
        command,
        reason: input.reason?.trim() || null,
        client: input.client,
      },
      input.signal,
    );
    if (!outcome.allowed) {
      audit?.append(
        'agent_command_denied',
        host.id,
        `${input.client} (${outcome.why}): ${clip(command, 500)}`,
      );
      const why = {
        denied:
          'The user denied this command. Do not retry it; ask the user what they want instead.',
        timeout: 'Nobody approved this command within 5 minutes, so it did not run.',
        cancelled: 'The request was cancelled before the user answered.',
      }[outcome.why];
      return { ran: false, reason: why };
    }

    const timeoutS = Math.min(
      Math.max(1, input.timeoutSeconds ?? DEFAULT_TIMEOUT_S),
      MAX_TIMEOUT_S,
    );
    const runId = this.nextRun++;
    this.running.set(runId, { hostId: host.id, command, client: input.client });
    this.changed();
    try {
      const result = await fleet.exec(host.id, command, timeoutS * 1000);
      audit?.append(
        'agent_command_run',
        host.id,
        `${input.client}, allowed by ${outcome.by === 'you' ? 'you' : 'trusted server'}: ${clip(command, 500)} → exit ${result.exitCode ?? '?'}`,
      );
      return {
        ran: true,
        serverId: host.id,
        exitCode: result.exitCode,
        stdout: headAndTail(result.stdout),
        stderr: headAndTail(result.stderr),
      };
    } catch (error) {
      const message = (error as Error).message;
      audit?.append(
        'agent_command_run',
        host.id,
        `${input.client}: ${clip(command, 500)} → failed: ${message}`,
      );
      return { ran: false, reason: `The command could not finish on ${host.name}: ${message}` };
    } finally {
      this.running.delete(runId);
      this.changed();
    }
  }

  /** Commands running right now. */
  get activity(): AgentActivity[] {
    return [...this.running.values()];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

function findHost(hosts: readonly Host[], wanted: string): Host | undefined {
  const key = wanted.trim().toLowerCase();
  return (
    hosts.find((host) => host.id.toLowerCase() === key) ??
    hosts.find((host) => host.name.toLowerCase() === key) ??
    hosts.find((host) => host.address.toLowerCase() === key)
  );
}

function summarize(host: Host, state: HostState | undefined, connected: boolean): ServerSummary {
  const percent = (used: number, total: number) =>
    total > 0 ? Math.round((used / total) * 100) : null;
  return {
    id: host.id,
    name: host.name,
    address: host.address,
    user: host.user,
    district: host.district,
    tags: [...host.tags],
    connected,
    status: state?.status ?? 'unknown',
    statusReason: state?.statusReason ?? null,
    os: state?.os ?? null,
    cpuPercent: state?.cpuPercent == null ? null : Math.round(state.cpuPercent),
    memoryPercent: state?.memory ? percent(state.memory.usedBytes, state.memory.totalBytes) : null,
    disks: (state?.disks ?? []).map(
      (disk) => `${disk.mount} ${percent(disk.usedBytes, disk.totalBytes) ?? '?'}%`,
    ),
    uptimeHours: state?.uptimeSeconds == null ? null : Math.round(state.uptimeSeconds / 3600),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function headAndTail(text: string): string {
  if (text.length <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) return text;
  const dropped = text.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
  return `${text.slice(0, OUTPUT_HEAD_CHARS)}\n… [${dropped} characters cut] …\n${text.slice(-OUTPUT_TAIL_CHARS)}`;
}
