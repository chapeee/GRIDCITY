/**
 * Spots commands that delete, wipe, uninstall, stop or shut down something,
 * so they still ask the user on a server marked "allow all". It errs toward
 * asking: a false alarm costs one click, a missed `rm -rf` can cost a server.
 *
 * Not a sandbox. Trust only skips the approval click; the AI can also mark a
 * command risky itself, and the user can always deny.
 */

import { HIDDEN_CHARACTERS } from '@app/shared';

/** Command word: not part of a longer word, a flag (`--rm`) or a file name. */
const cmd = (names: string) => `(?<![\\w.-])(?:${names})(?![\\w.-])`;

interface Rule {
  why: string;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    why: 'deletes files',
    pattern: /\bfind\b[^;&|]*\s-(?:delete\b|exec(?:dir)?\s+(?:\S*\/)?rm\b)/,
  },
  { why: 'deletes files', pattern: /\bmv\b[^;&|]*\s\/dev\/null\b/ },
  {
    why: 'wipes or repartitions a disk',
    pattern: new RegExp(
      cmd('mkfs(?:\\.\\w+)?|wipefs|fdisk|sfdisk|cfdisk|parted|sgdisk|blkdiscard|mkswap'),
    ),
  },
  { why: 'writes raw data to a disk or file', pattern: /\bdd\b[^;&|]*\bof=/ },
  { why: 'empties a file', pattern: new RegExp(cmd('truncate')) },
  {
    why: 'deletes database data',
    pattern:
      /\b(?:drop\s+(?:database|schema|table|user|role|index|view|collection)|truncate\s+(?:table\s+)?\w|delete\s+from|flushall|flushdb|dropdatabase\s*\(|\.drop\s*\(|deletemany\s*\(|alter\s+table\b[^;]*\bdrop\b)/i,
  },
  {
    why: 'removes containers, images or volumes',
    pattern:
      /\b(?:docker|podman|nerdctl)\s+(?:(?:rm|rmi|kill)\b|(?:system|image|volume|container|network|builder)\s+(?:prune|rm)\b|compose\s+(?:[^;&|]*\s)?(?:down|rm)\b)|\bdocker-compose\s+(?:[^;&|]*\s)?(?:down|rm)\b|\bcrictl\s+(?:rm|rmi)\b/,
  },
  {
    why: 'deletes cluster resources',
    pattern: /\bkubectl\s+(?:[^;&|]*\s)?(?:delete|drain)\b|\bhelm\s+(?:uninstall|delete)\b/,
  },
  {
    why: 'uninstalls packages',
    pattern:
      /\b(?:apt(?:-get)?|aptitude)\s+(?:-\S+\s+)*(?:remove|purge|autoremove)\b|\b(?:yum|dnf)\s+(?:-\S+\s+)*(?:remove|erase|autoremove)\b|\bapk\s+del\b|\bpacman\s+-R|\bzypper\s+(?:remove|rm)\b|\bsnap\s+remove\b|\bpip3?\s+uninstall\b|\bbrew\s+uninstall\b|\bnpm\s+(?:uninstall|un|remove|rm)\s+-g\b/,
  },
  {
    why: 'deletes users or scheduled jobs',
    pattern: new RegExp(
      `${cmd('userdel|groupdel|deluser|delgroup')}|\\bcrontab\\s+(?:-\\S+\\s+)*-r\\b`,
    ),
  },
  {
    why: 'reboots or shuts down the server',
    pattern: new RegExp(
      `${cmd('reboot|shutdown|poweroff|halt')}|\\binit\\s+[06]\\b|\\bsystemctl\\s+(?:reboot|poweroff|halt|kexec)\\b`,
    ),
  },
  {
    why: 'stops or disables a service',
    pattern: /\bsystemctl\s+(?:-\S+\s+)*(?:stop|disable|mask|kill)\b|\bservice\s+\S+\s+stop\b/,
  },
  {
    why: 'kills processes',
    pattern: new RegExp(`${cmd('killall|pkill')}|\\bkill\\s+-(?:9|KILL)\\b`),
  },
  {
    why: 'clears firewall rules',
    pattern:
      /\b(?:iptables|ip6tables)\s+(?:-\S+\s+)*(?:-F|--flush|-X)\b|\bufw\s+(?:reset|disable)\b|\bnft\s+flush\b/,
  },
  {
    why: 'discards git history or files',
    pattern:
      /\bgit\s+(?:reset\s+--hard|clean\s+-\w*f|push\s+(?:[^;&|]*\s)?(?:-f\b|--force)|branch\s+-D\b)/,
  },
  {
    why: 'deletes cloud resources',
    pattern:
      /\baws\s+s3\s+(?:rm|rb)\b|\baws\s+\S+\s+(?:delete|terminate|deregister)-|\b(?:gcloud|az|doctl)\s+[^;&|]*\b(?:delete|destroy)\b|\bterraform\s+(?:destroy|apply\s+[^;&|]*-destroy)\b/,
  },
  {
    why: 'changes ownership or permissions of the whole system',
    pattern: /\bch(?:mod|own|grp)\s+(?:-\S+\s+)*-R\s+\S+\s+\/(?:\s|$|\*)/,
  },
  {
    // Recursively on a system folder or a home: breaks sudo, sshd and services.
    why: 'changes ownership or permissions of system files',
    // A whole system folder, anything in /etc, system binaries or ~/.ssh;
    // not app folders like /srv/app or /var/www/html.
    pattern:
      /\bch(?:mod|own|grp)\s+(?:-\S+\s+)*-R\b[^;&|]*\s(?:\/(?:etc|usr|var|bin|sbin|lib\w*|boot|root|home)\/?(?=\s|$)|\/etc\/|\/usr\/(?:s?bin|lib\w*)\b|~\/?(?=\s|$)|~\/\.ssh\b)/,
  },
  {
    // The card cannot show what really runs: downloaded or decoded code, or eval.
    why: 'runs hidden code (downloaded, decoded or eval)',
    pattern:
      /\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b|\|\s*(?:sudo\s+)?(?:python[\d.]*|perl|ruby|node|php)\b(?!\s+-\S*[mc]\s*json)|(?<![\w.-])(?:ba|z)?sh\s+<\(|(?<![\w.-])source\s+<\(|(?<![\w.-])eval(?![\w.-])/,
  },
  {
    // Interpreter one-liners that delete (Python, Perl, Ruby, Node).
    why: 'deletes files',
    pattern:
      /\b(?:rmtree|os\.remove|os\.unlink|os\.rmdir|unlinkSync|rmSync|rmdirSync|FileUtils\.rm\w*|File\.delete)\b/,
  },
  {
    // Moving system configuration or SSH keys away can lock everyone out.
    why: 'moves system or SSH configuration away',
    pattern:
      /\bmv\b[^;&|]*\s(?:\/etc\/|\/boot\/|~\/\.ssh\b|\/root\/\.ssh\b|\S*\/\.ssh\/authorized_keys)/,
  },
  // Last: the specific rules above name the thing better (docker rm, aws s3 rm).
  { why: 'deletes files', pattern: new RegExp(cmd('rm|rmdir|unlink|shred|srm')) },
  { why: 'is a fork bomb', pattern: /:\s*\(\s*\)\s*\{/ },
];

/** `> file` overwrites it; `>>`, `2>&1` and `> /dev/null` do not. Checked outside quotes. */
const OVERWRITE = /(?<![>&\d])>(?![>&])\s*(?!\/dev\/(?:null|stdout|stderr)\b)[^\s|;&)]/;

const outsideQuotes = (command: string) =>
  command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

/** Why the command is destructive, in a few plain words, or null if it looks safe. */
export function commandRisk(command: string): string | null {
  // What you read on the card would not be what runs: always ask.
  if (HIDDEN_CHARACTERS.test(command)) {
    return 'contains invisible characters that change how it reads';
  }
  for (const rule of RULES) {
    if (rule.pattern.test(command)) return rule.why;
  }
  if (OVERWRITE.test(outsideQuotes(command))) return 'overwrites a file';
  return null;
}
