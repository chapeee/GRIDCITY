import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import type { ReactNode } from 'react';

const FEATURES: { title: string; key?: string; body: string; to: string }[] = [
  {
    title: 'The Doctor proves its fixes',
    key: 'D',
    body: '“Could not connect” becomes “stops at LOGIN: the server requires TLS”. Each candidate fix is tried with a real read-only connection before it is offered. One click applies it.',
    to: '/docs/guides/doctor/',
  },
  {
    title: 'Time travel',
    key: 'T',
    body: 'Drag the timeline and every tower shows its load, memory, disks and traffic as they were. Press Play to watch last night’s incident unfold.',
    to: '/docs/guides/time-travel/',
  },
  {
    title: 'Root cause and blast radius',
    body: 'The city knows who talks to whom. When ten things go red, it names the one that explains the others, and shows what goes down with each building.',
    to: '/docs/guides/topology/',
  },
  {
    title: 'An MCP server for your AI agent',
    body: 'Connect Claude Code, Cursor or any MCP app with one command. Your agent gets incident_report, security_findings, diagnose and get_topology, and every command it runs waits for your click.',
    to: '/docs/guides/ai-agents/',
  },
  {
    title: 'See who is attacking what',
    key: 'S',
    body: 'SSH brute force, a login after guessed passwords, new root accounts, public buckets, open databases: a red ring strikes the building, with the attacker, whether it is blocked, and one click to block it. CrowdSec and Fail2ban included.',
    to: '/docs/guides/security/',
  },
  {
    title: 'Manage databases and buckets',
    key: 'M',
    body: 'Tables and queries for PostgreSQL, MySQL, SQL Server and SQLite, keys and a console for Redis, documents for MongoDB, files and policies for S3. Read-only until you allow changes.',
    to: '/docs/guides/manage/',
  },
  {
    title: 'Alerts with the app closed',
    body: 'Browser push on Windows, macOS and Android, email, Slack, Discord, Telegram, Teams, ntfy and more, sent by the server, with an "over" message when it ends.',
    to: '/docs/guides/alerts/',
  },
  {
    title: 'Before things break',
    key: 'U',
    body: 'Certificates and domains that expire, disks that will be full in days, late backups, vulnerable packages, crash-looping containers and cloud cost spikes.',
    to: '/docs/guides/upcoming/',
  },
  {
    title: 'A real terminal',
    key: 'Enter',
    body: 'Dive into any server through the tower: a full xterm shell over the SSH connection the city already holds.',
    to: '/docs/guides/terminal/',
  },
  {
    title: 'Everything in the app',
    body: 'Servers, databases, buckets, probes and load balancers in forms. Passwords and keys are stored encrypted on your machine. No config files to edit.',
    to: '/docs/getting-started/connect-resources/',
  },
];

export default function Home(): ReactNode {
  return (
    <Layout
      title="Server monitoring, database admin and security as a 3D city, with an MCP server"
      description="Local-first monitoring for SSH servers, PostgreSQL, MySQL, MongoDB, Redis, S3 and AWS as a living 3D city: attack detection, database and bucket admin, alerts with the app closed, a Doctor that proves fixes, time travel, and an MCP server for Claude Code and other AI agents."
    >
      <header className="gc-hero">
        <h1>
          Your servers as a living <span>city of light</span>
        </h1>
        <p>
          Every server, database, bucket, load balancer and endpoint becomes a building whose light
          tells the truth about it. Monitor, manage, secure and fix them in one app, with your AI
          agent over MCP. Local-first: it runs on your machine and nothing leaves it.
        </p>
        <div className="gc-install">npx gridcity demo</div>
        <div className="gc-cta">
          <Link
            className="button button--primary button--lg"
            to="/docs/getting-started/quick-start/"
          >
            Quick start
          </Link>
          <Link className="button button--secondary button--lg" to="/docs/">
            Read the docs
          </Link>
        </div>
        <img
          className="gc-shot"
          src={useBaseUrl('/img/demo.gif')}
          alt="Flying through the city, focusing a degraded server and opening a terminal"
        />
      </header>
      <main className="gc-features">
        {FEATURES.map((feature) => (
          <Link key={feature.title} to={feature.to} className="gc-feature">
            <h3>
              {feature.title}
              {feature.key && <small>{feature.key}</small>}
            </h3>
            <p>{feature.body}</p>
          </Link>
        ))}
      </main>
    </Layout>
  );
}
