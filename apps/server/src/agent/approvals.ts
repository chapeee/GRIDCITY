import type { AgentApproval, ApprovalDecision, ApprovalInput } from '@app/shared';
import { randomUUID } from 'node:crypto';

/** What an AI asks to run. */
export interface ApprovalRequest {
  /** Chosen by the caller so it can refer to the request before it settles. */
  id?: string;
  hostId: string;
  hostName: string;
  command: string;
  reason: string | null;
  client: string;
  /** Something only the user can type, read by the command on stdin. */
  input?: ApprovalInput | null;
}

/** What the user sent back with a decision. */
export interface DecisionExtras {
  /** Instructions or a reason for the AI. */
  note?: string;
  /** The command's stdin (password, token). Never logged, never shown to the AI. */
  answer?: string;
}

export type ApprovalOutcome =
  | { allowed: true; by: 'you' | 'trusted-host'; note: string | null; answer: string | null }
  | { allowed: false; why: 'denied' | 'timeout' | 'cancelled'; note: string | null };

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

const clean = (text: string | undefined): string | null => text?.trim() || null;

/**
 * The one place an AI's command waits for the user. Commands run only after
 * an explicit "allow"; "allow on this server" trusts that host until the
 * server restarts (it is never saved). Unanswered requests are denied.
 *
 * A command that needs the user's input (a sudo password) always asks, even
 * on a trusted server: trust skips the click, not the answer.
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
    const input = request.input ?? null;
    if (this.trusted.has(request.hostId) && !input) {
      return Promise.resolve({ allowed: true, by: 'trusted-host', note: null, answer: null });
    }
    if (signal?.aborted) {
      return Promise.resolve({ allowed: false, why: 'cancelled', note: null });
    }

    return new Promise((resolve) => {
      const approval: AgentApproval = {
        id: request.id ?? randomUUID(),
        hostId: request.hostId,
        hostName: request.hostName,
        command: request.command,
        reason: request.reason,
        client: request.client,
        input,
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
      const onAbort = () => settle({ allowed: false, why: 'cancelled', note: null });
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () => settle({ allowed: false, why: 'timeout', note: null }),
        this.timeoutMs,
      );
      timer.unref?.();
      this.pending.set(approval.id, { approval, settle, timer });
      this.changed();
    });
  }

  /** Applies the user's answer. Unknown ids (already answered) are ignored. */
  decide(approvalId: string, decision: ApprovalDecision, extras: DecisionExtras = {}): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    const note = clean(extras.note);
    if (decision === 'deny') {
      entry.settle({ allowed: false, why: 'denied', note });
      return;
    }
    // Passwords keep their spaces; only an empty answer means "none".
    const answer = extras.answer ? extras.answer : null;
    if (entry.approval.input && !entry.approval.input.optional && answer === null) {
      return; // the card requires an answer; keep waiting
    }
    entry.settle({ allowed: true, by: 'you', note, answer });
    if (decision === 'allow-host') {
      const { hostId } = entry.approval;
      this.trusted.add(hostId);
      // Everything else already waiting on that host is now allowed too,
      // except commands that still need the user's input.
      for (const other of [...this.pending.values()]) {
        if (other.approval.hostId === hostId && !other.approval.input) {
          other.settle({ allowed: true, by: 'trusted-host', note: null, answer: null });
        }
      }
      this.changed();
    }
  }

  /** Back to asking for every command on this host. */
  untrust(hostId: string): void {
    if (this.trusted.delete(hostId)) this.changed();
  }

  /** Cancels one request (the AI stopped waiting for it). */
  cancel(approvalId: string): void {
    this.pending.get(approvalId)?.settle({ allowed: false, why: 'cancelled', note: null });
  }

  /** Denies everything still waiting (for example when the server stops). */
  cancelAll(): void {
    for (const entry of [...this.pending.values()])
      entry.settle({ allowed: false, why: 'cancelled', note: null });
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
