import type { RunResult } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { resultsSummary } from './RunbookPanel';

const result = (ok: boolean): RunResult => ({
  hostId: 'h',
  hostName: 'h',
  ok,
  exitCode: ok ? 0 : 1,
  stdout: '',
  stderr: '',
  error: null,
  durationMs: 800,
});

describe('resultsSummary', () => {
  it('never says a read-only run did something', () => {
    const text = resultsSummary([result(true)], true);
    expect(text).toContain('ran on 1 server');
    expect(text).toContain('nothing was changed');
    expect(text).not.toMatch(/succeeded|updated/);
  });

  it('counts failures', () => {
    expect(resultsSummary([result(true), result(false)], false)).toBe('1 of 2 servers failed');
  });
});
