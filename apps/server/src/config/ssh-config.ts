/**
 * Minimal OpenSSH client config reader for the host importer.
 *
 * Supported: `Host` blocks with multiple patterns, `*` / `?` wildcards and
 * `!` negation; `keyword value` and `keyword=value`; quoted values;
 * "first obtained value wins" across all matching blocks (so `Host *`
 * defaults at the end apply). Reported but not followed: `Match` and
 * `Include`. Only HostName, User, Port and IdentityFile are used.
 */

export interface SshConfigBlock {
  /** Patterns from the `Host` line; `['*']` for options before any Host line. */
  patterns: string[];
  /** Lowercased keyword -> values in order of appearance. */
  options: Map<string, string[]>;
}

export interface ParsedSshConfig {
  blocks: SshConfigBlock[];
  warnings: string[];
}

export interface ResolvedSshHost {
  alias: string;
  hostName: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
}

export function parseSshConfig(text: string): ParsedSshConfig {
  const blocks: SshConfigBlock[] = [{ patterns: ['*'], options: new Map() }];
  const warnings: string[] = [];
  let current: SshConfigBlock | null = blocks[0]!;

  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return;
      const match = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
      if (!match?.[1] || !match[2]) return;
      const keyword = match[1].toLowerCase();
      const value = match[2].trim();

      if (keyword === 'host') {
        current = { patterns: splitArguments(value), options: new Map() };
        blocks.push(current);
      } else if (keyword === 'match') {
        warnings.push(
          `line ${index + 1}: "Match" blocks are not supported; their options are ignored`,
        );
        current = null; // options until the next Host line belong to the Match block
      } else if (keyword === 'include') {
        warnings.push(`line ${index + 1}: "Include ${value}" is not followed`);
      } else if (current) {
        const values = current.options.get(keyword) ?? [];
        values.push(unquote(value));
        current.options.set(keyword, values);
      }
    });

  return { blocks, warnings };
}

/** True when `alias` matches the pattern list (any negated match excludes). */
export function matchesHostPatterns(alias: string, patterns: readonly string[]): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(alias)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

/** Concrete hosts (no wildcards) with their effective settings. */
export function resolveSshHosts(config: ParsedSshConfig): ResolvedSshHost[] {
  const aliases: string[] = [];
  for (const block of config.blocks.slice(1)) {
    for (const pattern of block.patterns) {
      if (!/[*?!]/.test(pattern) && !aliases.includes(pattern)) aliases.push(pattern);
    }
  }

  return aliases.map((alias) => {
    const first = (keyword: string): string | null => {
      for (const block of config.blocks) {
        if (!matchesHostPatterns(alias, block.patterns)) continue;
        const value = block.options.get(keyword)?.[0];
        if (value !== undefined) return value;
      }
      return null;
    };
    const port = first('port');
    return {
      alias,
      hostName: first('hostname')?.replace(/%h/g, alias) ?? alias,
      user: first('user'),
      port: port !== null && /^\d+$/.test(port) ? Number(port) : null,
      identityFile: first('identityfile'),
    };
  });
}

function splitArguments(value: string): string[] {
  return (value.match(/"[^"]*"|\S+/g) ?? []).map(unquote);
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
