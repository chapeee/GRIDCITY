import type { AgentApproval, ApprovalDecision } from '@app/shared';
import { randomUUID } from 'node:crypto';

/** What an AI asks to run. */
export interface ApprovalRequest {
  hostId: string;
  hostName: string;
  command: string;
  reason: string | null;
  client: string;
}

export type ApprovalOutcome =
  | { allowed: true; by: 'you' | 'trusted-host' }
  | { allowed: false; why: 'denied' | 'timeout' | 'cancelled' };

/** Unanswered requests are denied after this long, so an AI never waits forever. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
  approval: AgentApproval;
  settle(outcome: ApprovalOutcome): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApprovalGateOptions {
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The one place an AI's command waits for the user. Commands run only after
 * an explicit "allow"; "allow on this server" trusts that host until the
 * server restarts (it is never saved). Unanswered requests are denied.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, Pending>();
  private readonly trusted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: ApprovalGateOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Resolves once the user decides (or the request times out). */
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    if (this.trusted.has(request.hostId)) {
      return Promise.resolve({ allowed: true, by: 'trusted-host' });
    }
    if (signal?.aborted) return Promise.resolve({ allowed: false, why: 'cancelled' });

    return new Promise((resolve) => {
      const approval: AgentApproval = {
        id: randomUUID(),
        ...request,
        requestedAt: this.now(),
      };
      const settle = (outcome: ApprovalOutcome) => {
        const entry = this.pending.get(approval.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(approval.id);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
        this.changed();
      };
      const onAbort = () => settle({ allowed: false, why: 'cancelled' });
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => settle({ allowed: false, why: 'timeout' }), this.timeoutMs);
      timer.unref?.();
      this.pending.set(approval.id, { approval, settle, timer });
      this.changed();
    });
  }

  /** Applies the user's answer. Unknown ids (already answered) are ignored. */
  decide(approvalId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    if (decision === 'deny') {
      entry.settle({ allowed: false, why: 'denied' });
      return;
    }
    if (decision === 'allow-host') {
      const { hostId } = entry.approval;
      this.trusted.add(hostId);
      entry.settle({ allowed: true, by: 'you' });
      // Everything else already waiting on that host is now allowed too.
      for (const other of [...this.pending.values()]) {
        if (other.approval.hostId === hostId) other.settle({ allowed: true, by: 'trusted-host' });
      }
      return;
    }
    entry.settle({ allowed: true, by: 'you' });
  }

  /** Back to asking for every command on this host. */
  untrust(hostId: string): void {
    if (this.trusted.delete(hostId)) this.changed();
  }

  /** Denies everything still waiting (for example when the server stops). */
  cancelAll(): void {
    for (const entry of [...this.pending.values()])
      entry.settle({ allowed: false, why: 'cancelled' });
  }

  get approvals(): AgentApproval[] {
    return [...this.pending.values()].map((entry) => entry.approval);
  }

  get trustedHosts(): string[] {
    return [...this.trusted];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
