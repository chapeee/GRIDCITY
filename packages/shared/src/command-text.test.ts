import { describe, expect, it } from 'vitest';
import { revealCommand } from './command-text';

// Invisible characters, written as code points so the file stays plain ASCII.
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);

describe('revealCommand (the approval card shows what really runs)', () => {
  it('makes a right-to-left override visible instead of letting it reorder the text', () => {
    const shown = revealCommand(`echo ${RLO};touch /tmp/x #${PDF} ok`);
    expect(shown.text).toBe('echo ⟨U+202E⟩;touch /tmp/x #⟨U+202C⟩ ok');
    expect(shown.hidden).toBe(2);
  });

  it('shows zero-width characters, the byte order mark and stray controls', () => {
    const shown = revealCommand(`r${ZWSP}m -rf /${BOM}\r`);
    expect(shown.text).toBe('r⟨U+200B⟩m -rf /⟨U+FEFF⟩⟨U+000D⟩');
    expect(shown.hidden).toBe(3);
  });

  it('counts lines and collapses a long run of spaces that hides the end', () => {
    const tail = revealCommand(`df -h${' '.repeat(300)}; rm -rf /srv`);
    expect(tail.text).toBe('df -h ⟨300 spaces⟩ ; rm -rf /srv');
    expect(tail.longGap).toBe(true);
    expect(revealCommand(`df -h${'\n'.repeat(40)}touch /tmp/x`).lines).toBe(41);
  });

  it('leaves an ordinary command alone', () => {
    expect(revealCommand('sudo systemctl status nginx\tabc')).toEqual({
      text: 'sudo systemctl status nginx\tabc',
      hidden: 0,
      lines: 1,
      longGap: false,
    });
  });
});
