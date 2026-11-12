import { PutPublicAccessBlockCommand, S3Client } from '@aws-sdk/client-s3';
import type { ThreatFinding } from '@app/shared';
import type { ResourceConfigOf } from '../config/resources-file';
import type { ConnectorContext } from '../connectors/connector';
import { clientConfig } from '../connectors/s3';

/** A fix the user can apply from a finding, after seeing exactly what it does. */
export interface FixOption {
  id: 'block-ip' | 'lock-account' | 'make-private';
  label: string;
  description: string;
  /** What runs: the shell command on the server, or the API call. */
  preview: string;
}

export interface FixOutcome {
  ok: boolean;
  /** What happened, in plain words. */
  message: string;
  output: string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;
const USERNAME = /^[a-z_][a-z0-9_.-]{0,31}$/;

export const isSafeIp = (ip: string) => IPV4.test(ip) || (ip.includes(':') && IPV6.test(ip));

/**
 * Blocks an address with whatever the server has: Fail2ban, then CrowdSec,
 * then the firewall. Every tool runs through `sudo -n`, so a server where
 * sudo wants a password says so instead of hanging.
 */
export function blockIpScript(ip: string): string {
  return `set -e
if command -v fail2ban-client >/dev/null 2>&1 && sudo -n fail2ban-client status sshd >/dev/null 2>&1; then
  sudo -n fail2ban-client set sshd banip ${ip}; echo "blocked ${ip} with Fail2ban (sshd jail)"
elif command -v cscli >/dev/null 2>&1; then
  sudo -n cscli decisions add --ip ${ip} --duration 24h --reason "blocked from GRIDCITY"; echo "blocked ${ip} with CrowdSec for 24 h (needs a bouncer to take effect)"
else
  sudo -n iptables -I INPUT -s ${ip} -j DROP; echo "blocked ${ip} with iptables (until reboot)"
fi
`;
}

export function lockAccountScript(user: string): string {
  return `set -e\nsudo -n usermod -L -e 1 ${user}\necho "locked ${user}: password disabled and account expired (unlock with: usermod -U -e '' ${user})"\n`;
}

/** The fixes a finding offers. Values are validated: nothing from a log reaches a shell unchecked. */
export function fixesFor(
  finding: ThreatFinding,
  targetIsHost: boolean,
  isBucket: boolean,
): FixOption[] {
  const key = finding.id.slice(finding.targetId.length + 1);
  const options: FixOption[] = [];
  if (
    targetIsHost &&
    finding.status === 'open' &&
    finding.attackerIp &&
    isSafeIp(finding.attackerIp) &&
    finding.blocked !== true
  ) {
    options.push({
      id: 'block-ip',
      label: `Block ${finding.attackerIp}`,
      description:
        'Bans the address on this server with Fail2ban, CrowdSec or the firewall (whichever it has).',
      preview: blockIpScript(finding.attackerIp),
    });
  }
  const user = /^(?:user|uid0):(.+)$/.exec(key)?.[1];
  if (targetIsHost && finding.status === 'open' && user && USERNAME.test(user)) {
    options.push({
      id: 'lock-account',
      label: `Lock account ${user}`,
      description:
        'Disables its password and expires the account, so nobody can log in with it. Reversible.',
      preview: lockAccountScript(user),
    });
  }
  if (
    isBucket &&
    finding.status === 'open' &&
    (key === 'public-bucket' || key === 'no-public-access-block')
  ) {
    options.push({
      id: 'make-private',
      label: 'Block public access',
      description:
        'Turns on all four "Block public access" settings for this bucket. The policy stays, but no longer applies to the public.',
      preview:
        'S3 PutPublicAccessBlock: BlockPublicAcls, IgnorePublicAcls, BlockPublicPolicy, RestrictPublicBuckets = true',
    });
  }
  return options;
}

export interface FixDeps {
  exec(
    hostId: string,
    script: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  context: ConnectorContext;
  /** Injectable for tests. */
  blockPublicAccess?(config: ResourceConfigOf<'s3'>, bucket: string): Promise<void>;
}

export async function applyFix(
  option: FixOption,
  target: { hostId?: string; bucket?: { config: ResourceConfigOf<'s3'>; name: string } },
  deps: FixDeps,
): Promise<FixOutcome> {
  if (option.id === 'make-private') {
    if (!target.bucket)
      return { ok: false, message: 'This finding is not on a bucket.', output: '' };
    try {
      if (deps.blockPublicAccess)
        await deps.blockPublicAccess(target.bucket.config, target.bucket.name);
      else {
        const s3 = new S3Client(clientConfig(target.bucket.config, deps.context));
        try {
          await s3.send(
            new PutPublicAccessBlockCommand({
              Bucket: target.bucket.name,
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                IgnorePublicAcls: true,
                BlockPublicPolicy: true,
                RestrictPublicBuckets: true,
              },
            }),
          );
        } finally {
          s3.destroy();
        }
      }
      return {
        ok: true,
        message: `Public access to ${target.bucket.name} is now blocked.`,
        output: '',
      };
    } catch (error) {
      return {
        ok: false,
        message: `The storage refused: ${(error as Error).message}. The saved access key may lack s3:PutBucketPublicAccessBlock, or this provider does not support it.`,
        output: '',
      };
    }
  }
  if (!target.hostId) return { ok: false, message: 'This finding is not on a server.', output: '' };
  const result = await deps.exec(target.hostId, option.preview);
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
  if (result.exitCode === 0) {
    return { ok: true, message: result.stdout.trim().split('\n').pop() ?? 'Done.', output };
  }
  if (
    /a password is required|a terminal is required|may not run sudo|not allowed to execute/.test(
      result.stderr,
    )
  ) {
    return {
      ok: false,
      message:
        "This server's sudo needs a password for that, and GRIDCITY never types one. Run the command yourself in a terminal, or allow it without a password for this user.",
      output,
    };
  }
  return {
    ok: false,
    message: `It did not work (exit code ${result.exitCode ?? 'unknown'}).`,
    output,
  };
}
