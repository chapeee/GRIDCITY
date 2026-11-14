import { useState } from 'react';

const INSTALL_DOCS_URL = 'https://chapeee.github.io/GRIDCITY/docs/getting-started/installation/';

const COMMANDS = [
  { command: 'npx gridcity demo', note: 'the full app on a simulated city' },
  { command: 'npx gridcity', note: 'your own servers' },
];

/**
 * Install link, shown only on the GitHub Pages demo (`STATIC_DEMO=true`), where
 * visitors arrive without having installed anything. GitHub is the toolbar's Star.
 */
export function StaticDemoLinks() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (command: string) => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => setCopied(command))
      .catch(() => setCopied(null));
  };

  return (
    <div className="static-demo-links">
      <button
        type="button"
        className="static-demo-link is-primary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Install
      </button>
      {open && (
        <div className="static-demo-install" role="dialog" aria-label="Install GRIDCITY">
          <p>This page is a simulated city running in your browser. To run the real app:</p>
          <ul>
            {COMMANDS.map(({ command, note }) => (
              <li key={command}>
                <code>{command}</code>
                <button type="button" onClick={() => copy(command)}>
                  {copied === command ? 'Copied' : 'Copy'}
                </button>
                <small>{note}</small>
              </li>
            ))}
          </ul>
          <p>
            Needs Node.js 22.12+.{' '}
            <a href={INSTALL_DOCS_URL} target="_blank" rel="noreferrer">
              Installation guide
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
