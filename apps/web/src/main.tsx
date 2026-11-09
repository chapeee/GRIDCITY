import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyDesignTokensToCss } from './design/css-variables';
import './styles.css';

/**
 * The server sets an HttpOnly session cookie when the page is opened with
 * `?token=…`. Remove the token from the address bar right away so it does
 * not linger in history, bookmarks or screenshots.
 */
function stripSessionTokenFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('token')) return;
  url.searchParams.delete('token');
  window.history.replaceState(null, '', url);
}

stripSessionTokenFromUrl();
applyDesignTokensToCss();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element in index.html');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
