import { z } from 'zod';

/**
 * AI agent WebSocket protocol (`/ws/agent`).
 *
 * Two kinds of AI reach the fleet, and both end up here:
 * - **MCP clients** the user runs themselves (Claude Code, Claude Desktop,
 *   Cursor...) call the app's MCP endpoint.
 * - **ACP agents** (Codex, Gemini CLI...) the app starts for the user and
 *   shows in the agent panel.
 *
 * Every command either of them wants to run on a server becomes an
 * {@link AgentApproval} the user allows or denies here. Nothing runs first.
 */

/**
 * Something the command itself reads on stdin that only the user knows: a
 * sudo password, a token for `--password-stdin`, a y/n answer. The approval
 * card shows a field for it; the value goes straight to the command and is
 * never shown to the AI or written to the audit log.
 */
export const ApprovalInputSchema = z.object({
  /** What to ask, e.g. "sudo password for ubuntu". */
  prompt: z.string(),
  /** Hide what the user types (passwords, tokens). */
  secret: z.boolean(),
  /** The command may not need it (sudo with no password asked); Allow works empty. */
  optional: z.boolean(),
});
export type ApprovalInput = z.infer<typeof ApprovalInputSchema>;

/** A command an AI wants to run, waiting for the user. */
export const AgentApprovalSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  /** Exactly what will run (`sh -c` on the server). */
  command: z.string(),
  /** The AI's own explanation, if it gave one. */
  reason: z.string().nullable(),
  /** Who asks, e.g. "Claude Code" or "Codex". */
  client: z.string(),
  /** Set when the command reads an answer from the user on stdin. */
  input: ApprovalInputSchema.nullable(),
  /** Why it asks even on a trusted server (it deletes, stops or shuts down something), or null. */
  risk: z.string().nullable().default(null),
  /** The input is the server's sudo password: "Allow all" offers to save it for an hour. */
  sudo: z.boolean().default(false),
  /** A saved sudo password fills this card until then (epoch ms): the user only clicks Allow. */
  sudoSavedUntil: z.number().int().nullable().default(null),
  requestedAt: z.number().int(),
});
export type AgentApproval = z.infer<typeof AgentApprovalSchema>;

/** One line of the agent panel's conversation. */
export const AgentEntrySchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'agent', 'tool', 'system']),
  text: z.string(),
  /** For tools: where the call stands. */
  status: z.enum(['pending', 'running', 'done', 'failed']).nullable(),
});
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

/** An agent the panel can start. */
export const AgentChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Which login it uses, in plain words. */
  signIn: z.string(),
  available: z.boolean(),
  /** Why it is unavailable, or a tip. */
  note: z.string().nullable(),
});
export type AgentChoice = z.infer<typeof AgentChoiceSchema>;

export const AgentSessionPhaseSchema = z.enum([
  'idle',
  'starting',
  /** The agent wants the user to sign in (see `signInOptions`). */
  'signin',
  'ready',
  'working',
  'failed',
]);
export type AgentSessionPhase = z.infer<typeof AgentSessionPhaseSchema>;

export const AgentSessionSchema = z.object({
  agentId: z.string().nullable(),
  phase: AgentSessionPhaseSchema,
  /** Why it failed, or what it is waiting for. */
  message: z.string().nullable(),
  signInOptions: z.array(z.object({ id: z.string(), label: z.string() })),
  entries: z.array(AgentEntrySchema),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

/** A command an AI is running right now (the city lights that tower up). */
export const AgentActivitySchema = z.object({
  hostId: z.string(),
  command: z.string(),
  client: z.string(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;

export const AgentStateSchema = z.object({
  agents: z.array(AgentChoiceSchema),
  session: AgentSessionSchema,
  approvals: z.array(AgentApprovalSchema),
  activity: z.array(AgentActivitySchema),
  /** Hosts where the user chose "allow everything" until the server restarts. */
  trustedHosts: z.array(z.string()),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

/** Server -> client. The whole state each time: it is small. */
export const AgentServerMessageSchema = z.object({
  type: z.literal('state'),
  state: AgentStateSchema,
});
export type AgentServerMessage = z.infer<typeof AgentServerMessageSchema>;

export const ApprovalDecisionSchema = z.enum([
  'allow',
  /** Allow this and every later command on the same server, until restart. */
  'allow-host',
  'deny',
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Prompts are plain text; this keeps a pasted log from flooding the agent. */
const MAX_PROMPT_CHARS = 20_000;

/** Longest note the user can send back with a decision. */
export const MAX_APPROVAL_NOTE_CHARS = 2_000;
/** Longest stdin answer (password, token) the user can give a command. */
export const MAX_APPROVAL_ANSWER_CHARS = 4_000;

/** Client -> server. */
export const AgentClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('decide'),
    approvalId: z.string(),
    decision: ApprovalDecisionSchema,
    /** Instructions or a reason for the AI, returned with the result. */
    note: z.string().max(MAX_APPROVAL_NOTE_CHARS).optional(),
    /** What the command reads on stdin (see {@link ApprovalInputSchema}). Never logged. */
    answer: z.string().max(MAX_APPROVAL_ANSWER_CHARS).optional(),
    /** With "allow-host": keep the sudo password typed here in memory for one hour. */
    remember: z.boolean().optional(),
  }),
  z.object({ type: z.literal('untrust'), hostId: z.string() }),
  z.object({ type: z.literal('start'), agentId: z.string() }),
  z.object({ type: z.literal('signin'), methodId: z.string() }),
  z.object({ type: z.literal('prompt'), text: z.string().min(1).max(MAX_PROMPT_CHARS) }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('stop') }),
]);
export type AgentClientMessage = z.infer<typeof AgentClientMessageSchema>;
