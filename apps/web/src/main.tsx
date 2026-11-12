import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { establishSession } from './data/server-api';
import { installStaticDemoApi } from './data/static-demo-api';
import { applyDesignTokensToCss } from './design/css-variables';
import './styles.css';

applyDesignTokensToCss();
if (__STATIC_DEMO__) installStaticDemoApi();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element in index.html');

// The session cookie must exist before the first API call or WebSocket.
void establishSession().finally(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
