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
    title: 'Built for AI agents',
    body: 'Connect Claude Code with one command. Your agent gets incident_report, diagnose and get_topology, and every command it runs waits for your click.',
    to: '/docs/guides/ai-agents/',
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
      title="Your servers as a living city of light"
      description="Servers, databases, buckets and probes as a 3D city, with a Doctor that proves its fixes, time travel, real terminals and MCP tools for AI agents. Local-first."
    >
      <header className="gc-hero">
        <h1>
          Your servers as a living <span>city of light</span>
        </h1>
        <p>
          Every server, database, bucket, load balancer and endpoint becomes a building whose light
          tells the truth about it. Local-first: it runs on your machine and nothing leaves it.
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
