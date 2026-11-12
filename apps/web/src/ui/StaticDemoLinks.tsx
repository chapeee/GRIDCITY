import { useState } from 'react';

const REPOSITORY_URL = 'https://github.com/chapeee/GRIDCITY';
const INSTALL_DOCS_URL = 'https://chapeee.github.io/GRIDCITY/docs/getting-started/installation/';

const COMMANDS = [
  { command: 'npx gridcity demo', note: 'the full app on a simulated city' },
  { command: 'npx gridcity', note: 'your own servers' },
];

/**
 * GitHub and Install links, shown only on the GitHub Pages demo
 * (`STATIC_DEMO=true`), where visitors arrive without having installed anything.
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
      <a className="static-demo-link" href={REPOSITORY_URL} target="_blank" rel="noreferrer">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
          />
        </svg>
        GitHub
      </a>
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
