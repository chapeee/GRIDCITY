import type {
  AgentActivity,
  ApprovalInput,
  Host,
  HostState,
  Resource,
  ResourceMetric,
  ResourceState,
} from '@app/shared';
import { randomUUID } from 'node:crypto';
import type { ExecResult } from '../ssh/host-connection';
import type { AuditLog } from '../storage/audit-log';
import type { ApprovalGate, ApprovalOutcome } from './approvals';

/** What the tools need from the running fleet. */
export interface FleetAccess {
  hosts(): readonly Host[];
  states(): HostState[];
  isConnected(hostId: string): boolean;
  /** `stdin` is written to the command and then closed, so nothing waits on a prompt. */
  exec(hostId: string, command: string, timeoutMs: number, stdin?: string): Promise<ExecResult>;
  /** Databases, RDS instances and buckets from resources.yaml. */
  resources(): readonly Resource[];
  resourceStates(): ResourceState[];
  /** Demo data has no real servers to run commands on. */
  demoMode(): boolean;
}

export interface FleetToolsOptions {
  fleet: FleetAccess;
  gate: ApprovalGate;
  audit?: AuditLog;
  /** How long a call waits for the user before answering "waiting" (default 25 s). */
  waitMs?: number;
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

/** A database, RDS instance or bucket as an AI sees it. Never a secret. */
export interface ResourceSummary {
  id: string;
  name: string;
  kind: string;
  engine: string;
  district: string;
  tags: string[];
  /** Where it lives: "db.internal:5432", a file path, an endpoint. */
  target: string;
  status: string;
  statusReason: string | null;
  stale: boolean;
  lastSeen: string | null;
  /** Label -> value as shown in the app, "unknown" when not known. */
  metrics: Record<string, string>;
  error: string | null;
}

/** Input the AI says the command reads on stdin. */
export interface CommandInputRequest {
  prompt: string;
  secret?: boolean;
}

export interface RunCommandInput {
  /** Server id or name. */
  server: string;
  command: string;
  reason?: string;
  timeoutSeconds?: number;
  /** Something only the user knows that the command reads on stdin. */
  input?: CommandInputRequest;
  /** Who asks (shown on the approval card and in the audit log). */
  client: string;
  signal?: AbortSignal;
}

/** Where a command stands, as the AI is told. */
export type RunCommandResult =
  | {
      state: 'done';
      serverId: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      /** What the user wrote back when allowing. */
      note: string | null;
    }
  | { state: 'refused'; reason: string }
  | {
      /** Still waiting for the user (or still running): call waitForCommand. */
      state: 'waiting';
      requestId: string;
      serverName: string;
      phase: 'asking' | 'running';
      needsInput: boolean;
    };

type FinalResult = Extract<RunCommandResult, { state: 'done' | 'refused' }>;

interface Job {
  id: string;
  serverName: string;
  needsInput: boolean;
  phase: 'asking' | 'running';
  promise: Promise<FinalResult>;
  result: FinalResult | null;
}

export const MAX_COMMAND_CHARS = 10_000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;
/** Short enough that no MCP client times out, long enough for a quick click. */
export const DEFAULT_WAIT_MS = 25_000;
/** A finished result nobody collected is dropped after this long. */
const RESULT_KEEP_MS = 15 * 60 * 1000;
/** Output handed back to the AI: the start and the end, which is where errors are. */
const OUTPUT_HEAD_CHARS = 8_000;
const OUTPUT_TAIL_CHARS = 24_000;

/** `sudo` as a command word (start, after ; & | ( or $( or a space). */
const SUDO_WORD = /(^|[\s;&|(`]|\$\()sudo(?=\s|$)/;
const SUDO_WORDS = /(^|[\s;&|(`]|\$\()sudo(?=\s)(?!\s+(?:-S|--stdin)\b)/g;
const SUDO_NON_INTERACTIVE =
  /(^|[\s;&|(`]|\$\()sudo\s+(?:-[a-zA-Z]*n[a-zA-Z]*|--non-interactive)\b/;

export function usesSudo(command: string): boolean {
  return SUDO_WORD.test(command);
}

/** `sudo` -> `sudo -S -p ''`: read the password from stdin, print no prompt. */
export function withSudoStdin(command: string): string {
  return command.replace(SUDO_WORDS, "$1sudo -S -p ''");
}

/**
 * What the approval card should ask for, if anything. The AI may declare it
 * (a token for `--password-stdin`); a `sudo` by a non-root user gets an
 * optional password field on its own, because the AI cannot type it and
 * must never be handed it.
 */
export function inputFor(
  command: string,
  user: string,
  declared: CommandInputRequest | undefined,
): ApprovalInput | null {
  const prompt = declared?.prompt.trim();
  if (prompt)
    return { prompt: prompt.slice(0, 200), secret: declared?.secret ?? true, optional: false };
  if (user !== 'root' && usesSudo(command) && !SUDO_NON_INTERACTIVE.test(command)) {
    return {
      prompt: `sudo password for ${user} (leave empty if sudo does not ask)`,
      secret: true,
      optional: true,
    };
  }
  return null;
}

/**
 * The fleet, as tools an AI can call. Shared by the MCP endpoint (Claude
 * Code and other MCP clients) and the ACP agent panel, so both follow the
 * same rules: every command waits for the user's approval, runs over the
 * server's existing SSH connection, and lands in the audit log.
 *
 * An AI never hangs on the user: a call waits a short while, then answers
 * "waiting" with a request id so the AI can tell the user to look at the app
 * and pick the result up with {@link waitForCommand}.
 */
export class FleetTools {
  private readonly running = new Map<number, AgentActivity>();
  private nextRun = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: FleetToolsOptions) {}

  listServers(): ServerSummary[] {
    const states = new Map(this.options.fleet.states().map((state) => [state.hostId, state]));
    return this.options.fleet
      .hosts()
      .map((host) => summarize(host, states.get(host.id), this.options.fleet.isConnected(host.id)));
  }

  listResources(): ResourceSummary[] {
    const { fleet } = this.options;
    const states = new Map(fleet.resourceStates().map((state) => [state.resourceId, state]));
    return fleet
      .resources()
      .map((resource) => summarizeResource(resource, states.get(resource.id)));
  }

  async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    const { fleet } = this.options;
    if (fleet.demoMode()) {
      return refused('The app is showing demo data; there are no real servers to run commands on.');
    }
    const command = input.command.trim();
    if (!command) return refused('The command is empty.');
    if (command.length > MAX_COMMAND_CHARS) {
      return refused(`The command is longer than ${MAX_COMMAND_CHARS} characters.`);
    }
    const host = findHost(fleet.hosts(), input.server);
    if (!host) {
      const resource = findResource(fleet.resources(), input.server);
      if (resource) {
        return refused(
          `"${resource.name}" is a ${resource.engine} resource, not an SSH server. ` +
            'Commands run only on servers; use list_resources for its status, or run a client ' +
            '(psql, mysql, redis-cli, aws) on a server that can reach it.',
        );
      }
      const known =
        fleet
          .hosts()
          .map((h) => h.id)
          .join(', ') || 'none';
      return refused(`There is no server "${input.server}". Servers: ${known}.`);
    }
    if (!fleet.isConnected(host.id)) {
      return refused(`${host.name} is not connected right now, so nothing can run on it.`);
    }

    const approvalInput = inputFor(command, host.user, input.input);
    const job: Job = {
      id: randomUUID(),
      serverName: host.name,
      needsInput: approvalInput !== null,
      phase: 'asking',
      promise: Promise.resolve(refused('not started')),
      result: null,
    };
    const controller = new AbortController();
    job.promise = this.execute(job, host, command, approvalInput, input, controller.signal);
    this.jobs.set(job.id, job);
    void job.promise.then((result) => {
      job.result = result;
      setTimeout(() => this.jobs.delete(job.id), RESULT_KEEP_MS).unref?.();
    });
    return this.await(job, input.signal, () => controller.abort());
  }

  /** Picks up a command that answered "waiting" earlier. */
  async waitForCommand(requestId: string, signal?: AbortSignal): Promise<RunCommandResult> {
    const job = this.jobs.get(requestId.trim());
    if (!job) {
      return refused(
        `There is no command waiting with request_id "${requestId}". It was already collected, ` +
          'or it finished more than 15 minutes ago.',
      );
    }
    return this.await(job, signal, () => this.options.gate.cancel(job.id));
  }

  /** Commands running right now. */
  get activity(): AgentActivity[] {
    return [...this.running.values()];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits a while for the job; collects it when done, else answers "waiting". */
  private async await(
    job: Job,
    signal: AbortSignal | undefined,
    onAbort: () => void,
  ): Promise<RunCommandResult> {
    if (signal?.aborted) {
      onAbort();
      return refused('The request was cancelled before the user answered.');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const waited = await Promise.race([
      job.promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.options.waitMs ?? DEFAULT_WAIT_MS);
      }),
      new Promise<'aborted'>((resolve) => {
        abortListener = () => resolve('aborted');
        signal?.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (abortListener) signal?.removeEventListener('abort', abortListener);

    if (waited === 'aborted') {
      // Only an unanswered request is withdrawn; a running command finishes.
      if (job.phase === 'asking') onAbort();
      return refused('The request was cancelled before the user answered.');
    }
    if (waited === 'timeout') {
      return {
        state: 'waiting',
        requestId: job.id,
        serverName: job.serverName,
        phase: job.phase,
        needsInput: job.needsInput,
      };
    }
    this.jobs.delete(job.id);
    return waited;
  }

  private async execute(
    job: Job,
    host: Host,
    command: string,
    approvalInput: ApprovalInput | null,
    input: RunCommandInput,
    signal: AbortSignal,
  ): Promise<FinalResult> {
    const { fleet, gate, audit } = this.options;
    const outcome: ApprovalOutcome = await gate.request(
      {
        id: job.id,
        hostId: host.id,
        hostName: host.name,
        command,
        reason: input.reason?.trim() || null,
        client: input.client,
        input: approvalInput,
      },
      signal,
    );
    if (!outcome.allowed) {
      audit?.append(
        'agent_command_denied',
        host.id,
        `${input.client} (${outcome.why}${outcome.note ? ', with a note' : ''}): ${clip(command, 500)}`,
      );
      const said = outcome.note ? ` The user said: "${outcome.note}"` : '';
      const why = {
        denied: `The user denied this command.${said} Do not retry it; follow what the user said, or ask them in your chat what they want instead.`,
        timeout:
          'Nobody answered in the app within 5 minutes, so the command did not run. Ask the user in your chat whether they still want it.',
        cancelled: 'The request was cancelled before the user answered.',
      }[outcome.why];
      return refused(why);
    }

    const answer = outcome.answer;
    const toRun = answer && usesSudo(command) ? withSudoStdin(command) : command;
    const stdin = answer ? `${answer}\n` : '';
    const timeoutS = Math.min(
      Math.max(1, input.timeoutSeconds ?? DEFAULT_TIMEOUT_S),
      MAX_TIMEOUT_S,
    );
    const runId = this.nextRun++;
    job.phase = 'running';
    this.running.set(runId, { hostId: host.id, command, client: input.client });
    this.changed();
    const by = outcome.by === 'you' ? 'you' : 'trusted server';
    const extras = [answer ? 'with your input' : '', outcome.note ? 'with a note' : '']
      .filter(Boolean)
      .join(', ');
    try {
      const result = await fleet.exec(host.id, toRun, timeoutS * 1000, stdin);
      audit?.append(
        'agent_command_run',
        host.id,
        `${input.client}, allowed by ${by}${extras ? ` (${extras})` : ''}: ${clip(toRun, 500)} → exit ${result.exitCode ?? '?'}`,
      );
      return {
        state: 'done',
        serverId: host.id,
        exitCode: result.exitCode,
        stdout: headAndTail(hide(result.stdout, answer)),
        stderr: headAndTail(hide(result.stderr, answer)),
        note: outcome.note,
      };
    } catch (error) {
      const message = hide((error as Error).message, answer);
      audit?.append(
        'agent_command_run',
        host.id,
        `${input.client}: ${clip(toRun, 500)} → failed: ${message}`,
      );
      return refused(`The command could not finish on ${host.name}: ${message}`);
    } finally {
      this.running.delete(runId);
      this.changed();
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

function refused(reason: string): FinalResult {
  return { state: 'refused', reason };
}

/** A command that echoes its input must not hand the password to the AI. */
function hide(text: string, answer: string | null): string {
  if (!answer || answer.trim().length < 3) return text;
  return text.split(answer).join('••••••');
}

function findHost(hosts: readonly Host[], wanted: string): Host | undefined {
  const key = wanted.trim().toLowerCase();
  return (
    hosts.find((host) => host.id.toLowerCase() === key) ??
    hosts.find((host) => host.name.toLowerCase() === key) ??
    hosts.find((host) => host.address.toLowerCase() === key)
  );
}

function findResource(resources: readonly Resource[], wanted: string): Resource | undefined {
  const key = wanted.trim().toLowerCase();
  return resources.find(
    (resource) => resource.id.toLowerCase() === key || resource.name.toLowerCase() === key,
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

function summarizeResource(resource: Resource, state: ResourceState | undefined): ResourceSummary {
  const metrics: Record<string, string> = {};
  for (const metric of state?.metrics ?? []) metrics[metric.label] = formatMetric(metric);
  return {
    id: resource.id,
    name: resource.name,
    kind: resource.kind,
    engine: resource.engine,
    district: resource.district,
    tags: [...resource.tags],
    target: resource.target,
    status: state?.status ?? 'unknown',
    statusReason: state?.statusReason ?? null,
    stale: state?.stale ?? false,
    lastSeen: state?.lastSeenAt == null ? null : new Date(state.lastSeenAt).toISOString(),
    metrics,
    error: state?.error ?? null,
  };
}

const UNIT_SUFFIX: Record<ResourceMetric['unit'], string> = {
  percent: '%',
  bytes: ' bytes',
  perSec: '/s',
  perHour: '/h',
  count: '',
  seconds: ' s',
  ms: ' ms',
  bytesPerHour: ' bytes/h',
  text: '',
};

function formatMetric(metric: ResourceMetric): string {
  if (metric.unit === 'text') return metric.text ?? 'unknown';
  if (metric.value == null) return 'unknown';
  const value = Number.isInteger(metric.value) ? metric.value : Number(metric.value.toFixed(2));
  return `${metric.atLeast ? '≥ ' : ''}${value}${UNIT_SUFFIX[metric.unit]}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function headAndTail(text: string): string {
  if (text.length <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) return text;
  const dropped = text.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
  return `${text.slice(0, OUTPUT_HEAD_CHARS)}\n… [${dropped} characters cut] …\n${text.slice(-OUTPUT_TAIL_CHARS)}`;
}
