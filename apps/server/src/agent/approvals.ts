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
  /** The input is this server's sudo password (can be saved for an hour with "allow all"). */
  sudoPassword?: boolean;
  /**
   * Why this command still asks on a trusted server: it deletes, wipes, stops
   * or shuts down something (see command-risk.ts), or the AI marked it risky.
   */
  risk?: string | null;
}

/** What the user sent back with a decision. */
export interface DecisionExtras {
  /** Instructions or a reason for the AI. */
  note?: string;
  /** The command's stdin (password, token). Never logged, never shown to the AI. */
  answer?: string;
  /** With "allow all": keep this sudo password in memory for {@link SUDO_REMEMBER_MS}. */
  remember?: boolean;
}

export type ApprovalOutcome =
  | { allowed: true; by: 'you' | 'trusted-host'; note: string | null; answer: string | null }
  | { allowed: false; why: 'denied' | 'timeout' | 'cancelled'; note: string | null };

/** Unanswered requests are denied after this long, so an AI never waits forever. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** How long a sudo password saved with "allow all" is kept: one hour. */
export const SUDO_REMEMBER_MS = 60 * 60 * 1000;

interface SavedSudo {
  password: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Pending {
  approval: AgentApproval;
  request: ApprovalRequest;
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
 * an explicit "allow"; "allow all on this server" trusts that host until the
 * app restarts (it is never saved). Unanswered requests are denied.
 *
 * On a trusted server every command runs without asking, except:
 * - destructive ones (delete, wipe, uninstall, stop, shut down) and any the AI
 *   marked risky: they always ask, and say why;
 * - input the AI declared (a token): the user types it each time.
 * The sudo password: typed with "allow all", the user is asked whether to
 * save it for an hour. Saved, it is kept in memory for that server and never
 * written anywhere: commands that run without asking use it, and cards that
 * still ask come with it filled in, so the user only clicks Allow. It is
 * forgotten after the hour, when sudo rejects it, when the server is
 * untrusted, or when the app restarts.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, Pending>();
  private readonly trusted = new Set<string>();
  /** Sudo passwords saved with "allow all", per host, for an hour. Memory only, never logged. */
  private readonly sudoPasswords = new Map<string, SavedSudo>();
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
    const auto = this.autoAnswer(request);
    if (auto !== undefined) {
      return Promise.resolve({ allowed: true, by: 'trusted-host', note: null, answer: auto });
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
        risk: request.risk ?? null,
        sudo: request.sudoPassword ?? false,
        sudoSavedUntil: null,
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
      this.pending.set(approval.id, { approval, request, settle, timer });
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
    const { hostId } = entry.approval;
    // Passwords keep their spaces; only an empty answer means "none". An empty
    // sudo field with a saved password means "use the saved one": the app types it.
    const typed = extras.answer ? extras.answer : null;
    const saved = entry.request.sudoPassword ? this.savedSudo(hostId) : undefined;
    const answer = typed ?? (saved || null);
    if (entry.approval.input && !entry.approval.input.optional && answer === null) {
      return; // the card requires an answer; keep waiting
    }
    entry.settle({ allowed: true, by: 'you', note, answer });
    if (entry.request.sudoPassword && decision === 'allow-host' && extras.remember && typed) {
      this.rememberSudo(hostId, typed);
    }
    if (decision === 'allow-host') {
      this.trusted.add(hostId);
      // Everything else already waiting on that host is now allowed too,
      // unless it is destructive or needs an answer only the user can give.
      for (const other of [...this.pending.values()]) {
        const auto = this.autoAnswer(other.request);
        if (auto !== undefined) {
          other.settle({ allowed: true, by: 'trusted-host', note: null, answer: auto });
        }
      }
      this.changed();
    }
  }

  /** Back to asking for every command on this host. */
  untrust(hostId: string): void {
    const forgot = this.dropSudo(hostId);
    if (this.trusted.delete(hostId) || forgot) this.changed();
  }

  /** Sudo rejected the saved password: ask again next time. */
  forgetSudoPassword(hostId: string): void {
    if (this.dropSudo(hostId)) this.changed();
  }

  /** When the saved sudo password for this host is forgotten (epoch ms), or null if none. */
  sudoSavedUntil(hostId: string): number | null {
    if (this.savedSudo(hostId) === undefined) return null;
    return this.sudoPasswords.get(hostId)?.expiresAt ?? null;
  }

  private rememberSudo(hostId: string, password: string): void {
    this.dropSudo(hostId);
    const timer = setTimeout(() => {
      if (this.dropSudo(hostId)) this.changed();
    }, SUDO_REMEMBER_MS);
    timer.unref?.();
    this.sudoPasswords.set(hostId, { password, expiresAt: this.now() + SUDO_REMEMBER_MS, timer });
    this.changed();
  }

  /** The saved password, or undefined when none is saved or its hour is over. */
  private savedSudo(hostId: string): string | undefined {
    const saved = this.sudoPasswords.get(hostId);
    if (!saved) return undefined;
    if (saved.expiresAt <= this.now()) {
      this.dropSudo(hostId);
      return undefined;
    }
    return saved.password;
  }

  private dropSudo(hostId: string): boolean {
    const saved = this.sudoPasswords.get(hostId);
    if (!saved) return false;
    clearTimeout(saved.timer);
    return this.sudoPasswords.delete(hostId);
  }

  /**
   * The answer to run with when trust lets the request skip the card, or
   * undefined when the user has to see it.
   */
  private autoAnswer(request: ApprovalRequest): string | null | undefined {
    if (!this.trusted.has(request.hostId) || request.risk) return undefined;
    const input = request.input ?? null;
    if (!input) return null;
    if (request.sudoPassword) {
      const saved = this.savedSudo(request.hostId);
      if (saved !== undefined) return saved;
    }
    return undefined;
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
    return [...this.pending.values()].map(({ approval, request }) =>
      request.sudoPassword
        ? { ...approval, sudo: true, sudoSavedUntil: this.sudoSavedUntil(approval.hostId) }
        : approval,
    );
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
