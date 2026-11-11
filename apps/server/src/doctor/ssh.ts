import type { Diagnosis, DoctorHint, DoctorReport, Host } from '@app/shared';
import { hintOf } from '@app/shared';
import { connect as netConnect } from 'node:net';
import { connectionAdvice } from '../ssh/connection-advice';
import type { ConnectionTestResult } from '../ssh/test-connection';
import { climbLadder, type LadderOptions } from './ladder';
import { fix } from './rules';

export interface HostDoctorOptions {
  test(): Promise<ConnectionTestResult>;
  platform?: NodeJS.Platform;
  ladder?: LadderOptions;
  /** Reads the first line the port sends (the SSH banner); injectable for tests. */
  banner?: (host: string, port: number) => Promise<string | null>;
  now?: () => number;
}

/**
 * Diagnoses an SSH server: ladder (DNS, TCP), the banner (is it really SSH
 * on that port?), then a real connection test with the fleet's exact checks,
 * turned into a diagnosis with the platform-specific steps the connect flow
 * already knows. Never trusts a host key on its own.
 */
export async function diagnoseHost(host: Host, options: HostDoctorOptions): Promise<DoctorReport> {
  const now = options.now ?? Date.now;
  const ladder = await climbLadder(
    { host: host.address, port: host.port, rawTls: false },
    options.ladder,
  );
  const steps = ladder.steps.filter((step) => step.step !== 'tls');
  const diagnoses: Diagnosis[] = [];

  if (ladder.failedAt === null) {
    const banner = await (options.banner ?? readBanner)(host.address, host.port);
    if (banner && !banner.startsWith('SSH-')) {
      steps.push({
        step: 'login',
        status: 'failed',
        detail: `port ${host.port} answers "${banner.slice(0, 40)}", which is not SSH`,
        ms: null,
      });
      diagnoses.push({
        id: 'ssh.not-ssh',
        title: `Port ${host.port} runs something else, not SSH`,
        explanation:
          'Another service answers on this port. SSH is usually on 22; some providers move it (2222, or a custom port).',
        confidence: 'certain',
        evidence: [`banner: ${banner.slice(0, 80)}`],
        fixes: [
          fix({
            label: 'Use the SSH port',
            steps: ['Edit → Port: the port sshd listens on (grep Port /etc/ssh/sshd_config).'],
          }),
        ],
      });
    } else if (banner) {
      steps.push({
        step: 'login',
        status: 'ok',
        detail: `SSH server: ${banner.slice(0, 60)}`,
        ms: null,
      });
    }
  }

  const result = diagnoses.length === 0 ? await options.test() : null;
  if (result?.ok) {
    return {
      targetId: host.id,
      targetName: host.name,
      ok: true,
      error: null,
      ladder: steps,
      diagnoses: [],
      at: now(),
    };
  }
  if (result && !result.ok) {
    const advice = connectionAdvice(result, host, options.platform ?? process.platform);
    diagnoses.push(sshDiagnosis(result, advice, ladder.failedAt));
  }
  return {
    targetId: host.id,
    targetName: host.name,
    ok: false,
    error: result && !result.ok ? result.message : (diagnoses[0]?.title ?? null),
    ladder: steps,
    diagnoses,
    at: now(),
  };
}

function sshDiagnosis(
  result: Extract<ConnectionTestResult, { ok: false }>,
  advice: string[],
  failedAt: string | null,
): Diagnosis {
  const titles: Record<typeof result.problem, string> = {
    'host-key':
      result.hostKeyRefusal?.reason === 'changed'
        ? 'The server presents a DIFFERENT host key than before'
        : 'This server is not trusted yet (unknown host key)',
    auth: 'The server did not accept any of your keys',
    'wrong-user': `The server wants a different user${result.suggestedUser ? `: ${result.suggestedUser}` : ''}`,
    unreachable:
      failedAt === 'dns'
        ? 'The address does not resolve'
        : 'The server cannot be reached on its SSH port',
    other: 'The SSH connection failed',
  };
  const explanations: Record<typeof result.problem, string> = {
    'host-key':
      result.hostKeyRefusal?.reason === 'changed'
        ? 'This can be a reinstalled server, or someone intercepting the connection. Verify the new fingerprint out of band before trusting it.'
        : 'Like answering "yes" to ssh the first time: compare the fingerprint with your provider console, then trust it (Connect a server does this safely).',
    auth: 'The login reached sshd and was refused: the public key is not in authorized_keys for this user, or the agent has no key loaded.',
    'wrong-user':
      'Cloud images accept the key for root but only print "Please login as the user …" and disconnect.',
    unreachable: 'See the ladder: the first failed rung is where it breaks.',
    other: 'The message below is what the SSH library reported.',
  };
  return {
    id: `ssh.${result.problem}`,
    title: titles[result.problem],
    explanation: explanations[result.problem],
    confidence: 'certain',
    evidence: [
      result.message,
      ...(result.hostKeyRefusal ? [`fingerprint: ${result.hostKeyRefusal.fingerprint}`] : []),
    ],
    fixes:
      result.problem === 'wrong-user' && result.suggestedUser
        ? [
            fix({
              label: `Log in as ${result.suggestedUser}`,
              steps: [`Edit → User: ${result.suggestedUser}`],
            }),
          ]
        : [fix({ label: 'Do this', steps: advice.slice(1).length ? advice.slice(1) : advice })],
  };
}

/** A hint for a live offline host, from its connection error alone (no network). */
export function sshHint(error: string | null): DoctorHint | null {
  if (!error) return null;
  const rules: [RegExp, string, string][] = [
    [
      /All configured authentication methods failed|authentication/i,
      'The server refused your keys',
      'Load the key in ssh-agent or install it',
    ],
    [/ENOTFOUND|EAI_AGAIN/, 'The address does not resolve', 'Check the address'],
    [/ECONNREFUSED/, 'Nothing listens on the SSH port', 'Check sshd and the port'],
    [
      /ETIMEDOUT|EHOSTUNREACH|Timed out while waiting for handshake|keepalive/i,
      'The server does not answer: firewall, or it is down',
      'Allow this IP or check the server',
    ],
    [/host key/i, 'The host key is not trusted', 'Verify and trust the fingerprint'],
  ];
  for (const [pattern, title, action] of rules) {
    if (pattern.test(error)) return { id: 'ssh.hint', title, action };
  }
  return hintOf([]);
}

function readBanner(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    let data = '';
    const done = (value: string | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(data.trim() || null), 3000);
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1');
      if (data.includes('\n')) done(data.split(/\r?\n/)[0]!.trim());
    });
    socket.on('error', () => done(null));
  });
}
