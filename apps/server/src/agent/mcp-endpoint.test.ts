import { describe, expect, it } from 'vitest';
import { describeRunResult, mcpInstructions } from './mcp-endpoint';

describe('mcpInstructions', () => {
  const text = mcpInstructions('GridCity');

  it('tells the AI to point the user at the app before every command', () => {
    expect(text).toMatch(/Before each run_command, tell the user .* approval in GridCity/);
  });

  it('keeps ordinary questions in the AI chat and secrets in the app', () => {
    expect(text).toMatch(/belong in your own chat with the user, not in GridCity/);
    expect(text).toMatch(/Never ask the user\s+to paste a password/);
  });

  it('rules out interactive commands such as sudo su', () => {
    expect(text).toContain('no `sudo su`');
  });
});

describe('describeRunResult', () => {
  it('a waiting command names the app and how to collect it', () => {
    const { text, isError } = describeRunResult(
      {
        state: 'waiting',
        requestId: 'r-1',
        serverName: 'web-1',
        phase: 'asking',
        needsInput: true,
      },
      'GridCity',
    );
    expect(isError).toBe(false);
    expect(text).toContain('Please check GridCity to approve the command and type the input');
    expect(text).toContain('wait_for_command with request_id "r-1"');
  });

  it('a running command asks only to collect, not to approve', () => {
    const { text } = describeRunResult(
      {
        state: 'waiting',
        requestId: 'r-2',
        serverName: 'web-1',
        phase: 'running',
        needsInput: false,
      },
      'GridCity',
    );
    expect(text).toMatch(/^RUNNING/);
    expect(text).not.toContain('Please check');
  });

  it('passes the user note back with the output', () => {
    const { text } = describeRunResult({
      state: 'done',
      serverId: 'web-1',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      note: 'use apt, not snap',
    });
    expect(text).toContain('use apt, not snap');
  });
});
