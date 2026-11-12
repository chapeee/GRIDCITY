import { describe, expect, it } from 'vitest';
import { LogSearchSchema, logSearchScript, parseLogSearch } from './log-search';

describe('log search', () => {
  it('never lets the query reach the shell as code', () => {
    const search = LogSearchSchema.parse({ query: `"; rm -rf / #$(reboot)'` });
    const script = logSearchScript(search);
    expect(script).not.toContain('rm -rf');
    expect(script).not.toContain('$(reboot)');
    expect(script).toContain(Buffer.from(search.query).toString('base64'));
    expect(script).toContain('grep -i -F -e "$P"');
  });

  it('uses -E for regex searches and only the chosen sources', () => {
    const script = logSearchScript(
      LogSearchSchema.parse({ query: 'error|fatal', regex: true, sources: ['journal'] }),
    );
    expect(script).toContain('grep -i -E -e "$P"');
    expect(script).not.toContain('docker logs');
    expect(script).not.toContain('find /var/log');
  });

  it('groups lines by source and keeps notes', () => {
    const parsed = parseLogSearch(
      '@@source journal\nNov 12 sshd[1]: Failed password\n@@note journal: this user may not read the system journal\n@@source files\n/var/log/auth.log:Nov 12 Failed password\n@@end',
      200,
    );
    expect(parsed.lines.map((l) => l.source)).toEqual(['journal', 'files']);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.complete).toBe(true);
  });
});
