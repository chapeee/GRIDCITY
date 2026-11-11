import type { Diagnosis } from '@app/shared';
import { accessSync, constants, existsSync, statfsSync } from 'node:fs';
import { fix } from './rules';

/**
 * Checks of the machine the app runs on, the problems that break many
 * things at once: no ssh-agent, an unwritable data folder, low disk space,
 * an old Node, a config file with errors. Shown at the top of the Doctor
 * panel and logged at startup, so they are fixed before they cause noise.
 */
export interface EnvironmentFacts {
  platform: NodeJS.Platform;
  nodeVersion: string;
  dataDir: string;
  inContainer: boolean;
  /** ssh-agent socket or pipe the app would use, if any. */
  agentSocket: string | null;
  /** Keys the agent holds (null when the agent could not be asked). */
  agentKeyCount: number | null;
  knownHostsFile: string;
  hostCount: number;
  configErrors: string[];
  /** Hosts and resources whose address is localhost (matters in containers). */
  localhostTargets: string[];
}

export function environmentDiagnoses(facts: EnvironmentFacts): Diagnosis[] {
  const found: Diagnosis[] = [];
  const add = (diagnosis: Diagnosis) => found.push(diagnosis);

  const [major] = facts.nodeVersion.replace(/^v/, '').split('.').map(Number);
  if ((major ?? 0) < 22) {
    add({
      id: 'env.node-version',
      title: `Node.js ${facts.nodeVersion} is too old`,
      explanation: 'The app needs Node.js 22.12 or newer (24 recommended).',
      confidence: 'certain',
      evidence: [`running ${facts.nodeVersion}`],
      fixes: [
        fix({ label: 'Install Node.js 24', steps: ['https://nodejs.org, or nvm install 24'] }),
      ],
    });
  }

  try {
    accessSync(facts.dataDir, constants.W_OK);
  } catch {
    add({
      id: 'env.data-dir',
      title: 'The data folder is not writable',
      explanation: 'History, the audit log and saved credentials cannot be stored.',
      confidence: 'certain',
      evidence: [facts.dataDir],
      fixes: [
        fix({
          label: 'Fix permissions or move it',
          steps: ['Make the folder writable by this user, or set DATA_DIR to another folder.'],
        }),
      ],
    });
  }
  try {
    const stats = statfsSync(facts.dataDir);
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes < 512 * 1024 ** 2) {
      add({
        id: 'env.disk-space',
        title: 'Less than 512 MB free where the database lives',
        explanation: 'SQLite needs room for history; writes fail when the disk is full.',
        confidence: 'certain',
        evidence: [`${Math.round(freeBytes / 1024 ** 2)} MB free in ${facts.dataDir}`],
        fixes: [
          fix({
            label: 'Free space or shorten history',
            steps: ['Settings → Keep history for fewer days, or free disk space.'],
          }),
        ],
      });
    }
  } catch {
    // statfs unsupported here: nothing to say.
  }

  if (facts.hostCount > 0 && !facts.agentSocket) {
    add({
      id: 'env.no-agent',
      title: 'No ssh-agent is available',
      explanation:
        'Servers that log in with "agent" cannot connect. Key files and uploaded keys still work.',
      confidence: 'likely',
      evidence: [
        facts.platform === 'win32'
          ? 'the OpenSSH agent pipe was not found'
          : 'SSH_AUTH_SOCK is not set',
      ],
      fixes: [
        fix({
          label: 'Start the agent and add your key',
          command:
            facts.platform === 'win32'
              ? 'Start-Service ssh-agent; ssh-add'
              : 'eval "$(ssh-agent)" && ssh-add',
          steps: facts.inContainer
            ? [
                'In Docker, use uploaded keys (Connect a server → upload a key), or mount the agent (compose.ssh.example.yaml).',
              ]
            : [],
        }),
      ],
    });
  } else if (facts.hostCount > 0 && facts.agentKeyCount === 0) {
    add({
      id: 'env.agent-empty',
      title: 'The ssh-agent holds no keys',
      explanation: 'Servers that log in with "agent" will be refused until a key is loaded.',
      confidence: 'certain',
      evidence: ['ssh-add -l reports no identities'],
      fixes: [fix({ label: 'Load your key', command: 'ssh-add' })],
    });
  }

  if (facts.hostCount > 0 && !existsSync(facts.knownHostsFile)) {
    add({
      id: 'env.known-hosts',
      title: 'There is no known_hosts file yet',
      explanation:
        'Every server will be refused until its host key is trusted. Connect a server trusts it after you compare the fingerprint.',
      confidence: 'certain',
      evidence: [facts.knownHostsFile],
      fixes: [
        fix({
          label: 'Trust servers with Connect a server',
          steps: ['Ctrl+K → Connect a server…'],
        }),
      ],
    });
  }

  if (facts.inContainer && facts.localhostTargets.length > 0) {
    add({
      id: 'env.container-localhost',
      title: 'Some entries point at localhost, which is the container here',
      explanation: 'In Docker, use host.docker.internal for services on your computer.',
      confidence: 'certain',
      evidence: facts.localhostTargets.slice(0, 5),
      fixes: [
        fix({
          label: 'Edit them to host.docker.internal',
          steps: ['Run the Doctor on each: it proves the change before applying it.'],
        }),
      ],
    });
  }

  for (const error of facts.configErrors) {
    add({
      id: 'env.config',
      title: error.split('\n')[0] ?? 'A configuration file has errors',
      explanation: 'The last valid version keeps running until the file is fixed.',
      confidence: 'certain',
      evidence: error.split('\n').slice(1, 6),
      fixes: [
        fix({ label: 'Fix the file', steps: ['Edit it; the app reloads it automatically.'] }),
      ],
    });
  }
  return found;
}
