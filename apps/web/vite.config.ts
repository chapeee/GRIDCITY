import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig, type Plugin } from 'vite';

/** Repo root, where `.env.example` (defaults) and `.env` (overrides) live. */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function readEnvFile(name: string): Record<string, string | undefined> {
  const path = `${repoRoot}${name}`;
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

const fileEnv = { ...readEnvFile('.env.example'), ...readEnvFile('.env') };
/** Real environment variables (e.g. from Docker) win over env files. */
const readSetting = (key: string): string | undefined => process.env[key] ?? fileEnv[key];

const projectName = readSetting('PROJECT_NAME');
if (!projectName) {
  throw new Error('PROJECT_NAME is not set. Copy .env.example to .env.');
}

/**
 * `STATIC_DEMO=true` builds a server-less copy of the app that always runs the
 * in-browser demo fleet, for hosting on GitHub Pages. `WEB_BASE` is the path it
 * is served under (e.g. `/GRIDCITY/demo/`).
 */
const staticDemo = readSetting('STATIC_DEMO') === 'true';
const base = readSetting('WEB_BASE') ?? '/';

const serverPort = Number(readSetting('SERVER_PORT') ?? 4600);
const webPort = Number(readSetting('WEB_PORT') ?? 4601);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Replaces `%PROJECT_NAME%` in index.html so the name is never hardcoded there. */
function projectNameInHtml(name: string): Plugin {
  return {
    name: 'project-name-in-html',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll('%PROJECT_NAME%', escapeHtml(name)),
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), projectNameInHtml(projectName)],
  define: {
    __PROJECT_NAME__: JSON.stringify(projectName),
    __STATIC_DEMO__: JSON.stringify(staticDemo),
  },
  server: {
    // Docker sets VITE_HOST=0.0.0.0; compose publishes it on 127.0.0.1 only.
    host: readSetting('VITE_HOST') ?? '127.0.0.1',
    port: webPort,
    strictPort: true,
    // File events do not always cross the Docker bind mount on Windows/macOS.
    watch:
      readSetting('WATCH_POLLING') === 'true' ? { usePolling: true, interval: 300 } : undefined,
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
});
