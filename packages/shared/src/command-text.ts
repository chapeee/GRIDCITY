/**
 * Shows a command exactly as it will run, for the approval card. A command
 * can be made to look harmless: invisible or right-to-left characters reorder
 * what you read ("Trojan Source"), and a long run of spaces or blank lines
 * pushes the real work out of view. Both are made visible here.
 */

/**
 * Characters that change how text reads without being seen: controls other
 * than tab and newline, bidirectional overrides and isolates, zero-width
 * characters, the byte order mark and the soft hyphen.
 */
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], // controls before tab
  [0x0b, 0x1f], // controls after newline (vertical tab, carriage return, escape…)
  [0x7f, 0x9f], // delete and the C1 controls
  [0xad, 0xad], // soft hyphen
  [0x61c, 0x61c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space/joiners, left-to-right and right-to-left marks
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x2069], // bidirectional isolates
  [0xfeff, 0xfeff], // byte order mark
];

/** Written as code points so no editor or formatter can turn them into the real thing. */
const hex = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`;
export const HIDDEN_CHARACTERS = new RegExp(
  `[${HIDDEN_RANGES.map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`)).join('')}]`,
);

/** This many spaces or tabs in a row are shown as a count. */
const LONG_GAP = 12;

export interface RevealedCommand {
  /** The command with hidden characters as ⟨U+XXXX⟩ and long gaps as ⟨N spaces⟩. */
  text: string;
  /** How many hidden characters it contains. */
  hidden: number;
  /** Lines, counting the last one. */
  lines: number;
  /** A run of spaces long enough to push text out of view was collapsed. */
  longGap: boolean;
}

export function revealCommand(command: string): RevealedCommand {
  let hidden = 0;
  let longGap = false;
  const text = command
    .replace(new RegExp(HIDDEN_CHARACTERS.source, 'g'), (char) => {
      hidden++;
      return `⟨U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`;
    })
    .replace(new RegExp(`[ \\t]{${LONG_GAP},}`, 'g'), (gap) => {
      longGap = true;
      return ` ⟨${gap.length} spaces⟩ `;
    });
  return { text, hidden, lines: command.split('\n').length, longGap };
}
