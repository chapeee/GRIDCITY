import type { Host } from '@app/shared';
import { knownHostsName } from './known-hosts';
import type { ConnectionTestResult } from './test-connection';

/**
 * Turns a failed connection test into concrete next steps, with commands for
 * the platform this server runs on. Shown by the "Add host" dialog and by
 * `npm run add-host`. Never suggests trusting a key without verifying it.
 */
export function connectionAdvice(
  result: ConnectionTestResult,
  host: Host,
  platform: NodeJS.Platform,
): string[] {
  if (result.ok) return [];
  const target = `${host.user}@${host.address}`;
  const sshCommand = host.port === 22 ? `ssh ${target}` : `ssh -p ${host.port} ${target}`;
  const windows = platform === 'win32';

  switch (result.problem) {
    case 'host-key': {
      const fingerprint = result.hostKeyRefusal?.fingerprint ?? 'shown above';
      if (result.hostKeyRefusal?.reason === 'changed') {
        return [
          `The host key CHANGED (now ${fingerprint}). This could be an attack, or the server was reinstalled.`,
          'Confirm the new fingerprint with the server owner or its console before trusting it.',
          `Only then remove the old key: ssh-keygen -R ${knownHostsName(host.address, host.port)}`,
          `Then connect once and accept the new key: ${sshCommand}`,
        ];
      }
      return [
        `This host is not trusted yet. Its key fingerprint is ${fingerprint}.`,
        'Check it against the server console or your provider dashboard.',
        `Then connect once and answer "yes": ${sshCommand}`,
        'Run the connection test again.',
      ];
    }

    case 'auth':
      if (host.auth.method === 'keyFile') {
        return [
          result.message,
          'Passphrase-protected keys must be loaded into ssh-agent instead (method: agent).',
          `The public key must be in ~/.ssh/authorized_keys on ${host.address}.`,
        ];
      }
      return [
        'The server did not accept any key from your ssh-agent (or no agent is running).',
        windows
          ? 'Start the agent (admin PowerShell, once): Start-Service ssh-agent'
          : 'Start the agent: eval "$(ssh-agent)"',
        'Load your key: ssh-add   (no key yet? create one: ssh-keygen -t ed25519)',
        windows
          ? `Install it on the server (asks the password once, never stored): type $env:USERPROFILE\\.ssh\\id_ed25519.pub | ${sshCommand} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`
          : `Install it on the server (asks the password once, never stored): ssh-copy-id ${host.port === 22 ? '' : `-p ${host.port} `}${target}`,
      ];

    case 'unreachable':
      return [
        result.message,
        `Check that ${host.address} is on, reachable from this machine, and runs SSH on port ${host.port}.`,
        `Try it directly: ${sshCommand}`,
      ];

    default:
      return [result.message, `Try it directly: ${sshCommand}`];
  }
}
