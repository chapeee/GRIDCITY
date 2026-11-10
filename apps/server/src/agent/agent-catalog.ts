import type { AgentChoice } from '@app/shared';

/**
 * ACP agents the panel can start. Each one is the vendor's own open-source
 * adapter, run with npx (pinned, so an update never changes behaviour
 * silently) and signed in with the user's own account.
 *
 * Claude is the exception: Anthropic does not allow third-party apps to use
 * a Claude subscription login, so in the panel it needs an API key. With a
 * subscription, the user runs Claude Code themselves and connects it to the
 * MCP endpoint instead (see the panel's "Use Claude Code" section).
 */
export interface AgentDefinition {
  id: string;
  label: string;
  /** Which login it uses, in plain words. */
  signIn: string;
  command: string;
  args: string[];
  /** Returns why the agent cannot start here, or null. */
  unavailableReason(env: NodeJS.ProcessEnv): string | null;
}

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    signIn: 'Your ChatGPT subscription, or OPENAI_API_KEY',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp@0.16.0'],
    unavailableReason: () => null,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI (Google)',
    signIn: 'Your Google account, or GEMINI_API_KEY',
    command: 'npx',
    args: ['-y', '@google/gemini-cli@0.67.0', '--acp'],
    unavailableReason: () => null,
  },
  {
    id: 'claude',
    label: 'Claude (Anthropic API)',
    signIn: 'ANTHROPIC_API_KEY (for your Claude subscription, use Claude Code below)',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.103.0'],
    unavailableReason: (env) =>
      env.ANTHROPIC_API_KEY
        ? null
        : 'Needs ANTHROPIC_API_KEY. With a Claude subscription, connect Claude Code instead.',
  },
];

export function agentChoices(
  definitions: readonly AgentDefinition[],
  env: NodeJS.ProcessEnv,
): AgentChoice[] {
  return definitions.map((definition) => {
    const reason = definition.unavailableReason(env);
    return {
      id: definition.id,
      label: definition.label,
      signIn: definition.signIn,
      available: reason === null,
      note: reason ?? 'The first start downloads the agent, which can take a minute.',
    };
  });
}
