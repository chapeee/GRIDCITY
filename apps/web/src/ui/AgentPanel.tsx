import type { AgentActivity, AgentApproval, AgentEntry } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useAgentStore } from '../data/agent-store';
import { fetchMcpSetup, type McpSetup } from '../data/server-api';
import { useServerLink } from '../data/server-link';
import { useUiStore } from './ui-store';
import { useSpeechInput } from './use-speech-input';

// Stable empty values: a new [] per render would make the store selectors loop.
const NO_APPROVALS: AgentApproval[] = [];
const NO_ACTIVITY: AgentActivity[] = [];

/**
 * Commands an AI wants to run, waiting for the user. Shown on top of
 * everything (the city, the panel, even an open terminal), because Claude
 * Code may ask while the panel is closed. Nothing runs until a click.
 */
export function ApprovalCards() {
  const approvals = useAgentStore((store) => store.state?.approvals ?? NO_APPROVALS);
  const activity = useAgentStore((store) => store.state?.activity ?? NO_ACTIVITY);
  if (approvals.length === 0 && activity.length === 0) return null;
  return (
    <div className="approval-stack" aria-live="polite">
      {activity.map((run, index) => (
        <p key={`${run.hostId}-${index}`} className="approval-running">
          <span className="approval-dot" aria-hidden="true" />
          {run.client} is running <code>{run.command}</code> on {run.hostId}
        </p>
      ))}
      <AnimatePresence initial={false}>
        {approvals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ApprovalCard({ approval }: { approval: AgentApproval }) {
  const send = useAgentStore((store) => store.send);
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState('');
  const [showNote, setShowNote] = useState(false);
  const needsAnswer = approval.input !== null && !approval.input.optional && answer === '';
  const decide = (decision: 'allow' | 'allow-host' | 'deny') => {
    send({
      type: 'decide',
      approvalId: approval.id,
      decision,
      note: note.trim() || undefined,
      // The answer goes to the command's stdin only; it is dropped with the card.
      answer: decision === 'deny' || answer === '' ? undefined : answer,
    });
    setAnswer('');
  };
  return (
    <motion.section
      className="approval-card"
      role="alertdialog"
      aria-label={`${approval.client} wants to run a command on ${approval.hostName}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 30 }}
      transition={{ duration: 0.16 }}
    >
      <p className="approval-title">
        <strong>{approval.client}</strong> wants to run on <strong>{approval.hostName}</strong>
      </p>
      <pre className="approval-command">{approval.command}</pre>
      {approval.reason && <p className="approval-reason">{approval.reason}</p>}
      {approval.risk && (
        <p className="approval-risk">Asks even with "allow all": this command {approval.risk}.</p>
      )}
      {approval.input && (
        <label className="approval-input">
          <span>{approval.input.prompt}</span>
          <input
            type={approval.input.secret ? 'password' : 'text'}
            autoComplete="off"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={approval.input.optional ? 'optional' : 'required to allow'}
          />
          <small>Goes to the command only. Never shown to the AI, never logged.</small>
        </label>
      )}
      {showNote ? (
        <label className="approval-input">
          <span>Note for {approval.client}</span>
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. use apt, not snap · or why you deny"
          />
        </label>
      ) : (
        <button type="button" className="link-button" onClick={() => setShowNote(true)}>
          Add a note for the AI…
        </button>
      )}
      <div className="approval-actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => decide('allow')}
          disabled={needsAnswer}
          title={needsAnswer ? 'The command needs your input first' : undefined}
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => decide('allow-host')}
          title="Until the app restarts: commands run without asking, and a sudo password typed here is remembered. Destructive commands still ask."
        >
          Allow all on {approval.hostName}
        </button>
        <button type="button" onClick={() => decide('deny')}>
          Deny
        </button>
      </div>
    </motion.section>
  );
}

/**
 * The AI agent panel: start Codex, Gemini CLI or Claude (API key) with the
 * user's own sign-in and talk to it, by typing or by voice. The agent works
 * on servers only through the app's tools, so every command shows up as an
 * approval card first. Also explains how to connect Claude Code (MCP).
 */
export function AgentPanel() {
  const open = useUiStore((store) => store.agentPanelOpen);
  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="agent-panel"
          aria-label="AI agents"
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 16 }}
          transition={{ duration: 0.18 }}
        >
          <AgentPanelBody />
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function AgentPanelBody() {
  const state = useAgentStore((store) => store.state);
  const connected = useAgentStore((store) => store.connected);
  const browserDemo = useServerLink((store) => store.source === 'browser-demo');
  const send = useAgentStore((store) => store.send);
  const [chosen, setChosen] = useState('');
  const close = () => useUiStore.getState().setAgentPanelOpen(false);

  const session = state?.session;
  const phase = session?.phase ?? 'idle';
  const running =
    phase === 'starting' || phase === 'signin' || phase === 'ready' || phase === 'working';
  const agents = state?.agents ?? [];
  const selected = chosen || session?.agentId || agents.find((a) => a.available)?.id || '';
  const selectedAgent = agents.find((agent) => agent.id === selected);

  return (
    <>
      <header className="agent-header">
        <h2>AI agents</h2>
        <button type="button" onClick={close}>
          Close <kbd>Esc</kbd>
        </button>
      </header>
      {browserDemo ? (
        <p className="agent-note">
          This page runs demo data in the browser; AI agents run on the server. Try them with{' '}
          <code>npx gridcity demo</code>.
        </p>
      ) : (
        !connected && <p className="agent-note">Connecting to the app…</p>
      )}

      <div className="agent-start">
        <label className="agent-select">
          <span>Agent</span>
          <select
            value={selected}
            onChange={(event) => setChosen(event.target.value)}
            disabled={running}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id} disabled={!agent.available}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        {running ? (
          <button type="button" onClick={() => send({ type: 'stop' })}>
            Stop agent
          </button>
        ) : (
          <button
            type="button"
            className="button-primary"
            disabled={!selectedAgent?.available}
            onClick={() => send({ type: 'start', agentId: selected })}
          >
            Start
          </button>
        )}
      </div>
      {selectedAgent && !running && (
        <p className="agent-note">
          Signs in with: {selectedAgent.signIn}. {selectedAgent.note}
        </p>
      )}

      {phase === 'signin' && session && (
        <div className="agent-signin">
          <p>{session.message}</p>
          {session.signInOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className="button-primary"
              onClick={() => send({ type: 'signin', methodId: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      <Conversation entries={session?.entries ?? []} working={phase === 'working'} />
      <PromptBox
        ready={phase === 'ready'}
        working={phase === 'working'}
        onSend={(text) => send({ type: 'prompt', text })}
        onCancel={() => send({ type: 'cancel' })}
      />

      {state && state.trustedHosts.length > 0 && (
        <p className="agent-trusted">
          Runs without asking on:{' '}
          {state.trustedHosts.map((hostId) => (
            <button
              key={hostId}
              type="button"
              className="link-button"
              title="Ask again for every command"
              onClick={() => send({ type: 'untrust', hostId })}
            >
              {hostId} ✕
            </button>
          ))}
        </p>
      )}

      <ClaudeCodeSetup />
    </>
  );
}

const ROLE_LABEL: Record<AgentEntry['role'], string> = {
  user: 'You',
  agent: 'Agent',
  tool: 'Tool',
  system: '',
};

function Conversation({ entries, working }: { entries: AgentEntry[]; working: boolean }) {
  const end = useRef<HTMLLIElement | null>(null);
  const last = entries[entries.length - 1];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, last?.text]);

  if (entries.length === 0) {
    return (
      <div className="agent-conversation agent-empty">
        <p>Ask in plain words, for example:</p>
        <ul>
          <li>Why is web-1 slow?</li>
          <li>Which server is running out of disk, and what is filling it?</li>
          <li>Update the packages on the staging servers.</li>
        </ul>
        <p>You see and approve every command before it runs.</p>
      </div>
    );
  }
  return (
    <ol className="agent-conversation" aria-live="polite">
      {entries.map((entry) => (
        <li key={entry.id} className={`agent-entry is-${entry.role}`}>
          {ROLE_LABEL[entry.role] && <span className="agent-role">{ROLE_LABEL[entry.role]}</span>}
          <span className="agent-text">{entry.text}</span>
          {entry.status && (
            <span className={`agent-status is-${entry.status}`}>{entry.status}</span>
          )}
        </li>
      ))}
      {working && <li className="agent-entry is-system agent-working">working…</li>}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

function PromptBox({
  ready,
  working,
  onSend,
  onCancel,
}: {
  ready: boolean;
  working: boolean;
  onSend(text: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState('');
  const speech = useSpeechInput(setText);
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || !ready) return;
    onSend(trimmed);
    setText('');
  };
  return (
    <form
      className="agent-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        aria-label="Message to the agent"
        placeholder={ready ? 'Ask the agent… (Enter to send)' : 'Start an agent first'}
        value={text}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="agent-prompt-actions">
        {speech.supported && (
          <button
            type="button"
            className={speech.listening ? 'is-listening' : undefined}
            aria-pressed={speech.listening}
            title="Speak instead of typing. The browser's speech service transcribes it."
            onClick={speech.listening ? speech.stop : speech.start}
          >
            {speech.listening ? 'Listening…' : 'Speak'}
          </button>
        )}
        {working ? (
          <button type="button" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button-primary" disabled={!ready || !text.trim()}>
            Send
          </button>
        )}
      </div>
      {speech.error && <p className="agent-error">{speech.error}</p>}
    </form>
  );
}

/** Ready-to-paste setup for Claude Code (and other MCP apps), with the user's own subscription. */
function ClaudeCodeSetup() {
  const [setup, setSetup] = useState<McpSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [openDetails, setOpenDetails] = useState(false);

  useEffect(() => {
    if (!openDetails || setup) return;
    fetchMcpSetup()
      .then(setSetup)
      .catch((reason: unknown) => setError((reason as Error).message));
  }, [openDetails, setup]);

  const copy = (label: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <details
      className="agent-mcp"
      open={openDetails}
      onToggle={(e) => setOpenDetails(e.currentTarget.open)}
    >
      <summary>Use Claude Code with your Claude subscription</summary>
      <p className="agent-note">
        Run this once in a terminal. Then ask Claude Code about your servers; its commands appear
        here for you to approve.
      </p>
      {error && <p className="agent-error">{error}</p>}
      {setup && (
        <>
          <pre className="agent-command">{setup.claudeCode}</pre>
          <button type="button" onClick={() => copy('claude', setup.claudeCode)}>
            {copied === 'claude' ? 'Copied' : 'Copy command'}
          </button>
          <p className="agent-note">
            Other MCP apps (Cursor, Claude Desktop with a bridge, Codex CLI): server URL{' '}
            <code>{setup.url}</code>, with the same Authorization header.
          </p>
          <button type="button" onClick={() => copy('json', JSON.stringify(setup.json, null, 2))}>
            {copied === 'json' ? 'Copied' : 'Copy JSON config'}
          </button>
          <p className="agent-note">This command contains your session key: keep it private.</p>
        </>
      )}
    </details>
  );
}
