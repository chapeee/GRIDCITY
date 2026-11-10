import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { useServerLink } from '../data/server-link';
import { accents, neutrals } from '../design/tokens';
import { openTerminalSession, type TerminalStatus } from './terminal-session';
import { useUiStore } from './ui-store';
import { hasHardwareWebGL } from './webgl-capability';

/** Delay before returning to the city after the shell exits cleanly, ms. */
const RETURN_AFTER_EXIT_MS = 700;
/** Resize messages are coalesced while the window is being dragged, ms. */
const RESIZE_DEBOUNCE_MS = 100;

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const STATUS_LABEL: Record<TerminalStatus, string> = {
  connecting: 'connecting',
  connected: 'connected',
  ended: 'session ended',
  disconnected: 'disconnected',
  failed: 'failed',
  demo: 'demo data',
};

/** Exit chord: Esc, Ctrl+K and friends belong to the shell (vim, readline). */
export function isExitChord(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'x';
}

/**
 * Full-screen real terminal on the focused host, shown once the dive has
 * finished. A clean `exit` returns to the city; errors and dropped
 * connections stay on screen with a way to reconnect.
 */
export function TerminalView() {
  const session = useUiStore((store) => store.terminal);
  const hostId = session?.phase === 'open' ? session.hostId : null;
  const host = useFleetStore((store) => store.hosts.find((h) => h.id === hostId));
  const isDemo = useFleetStore((store) => store.dataMode === 'demo');
  const browserDemo = useServerLink((store) => store.source === 'browser-demo');
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!hostId || !container) return;
    const { exitTerminal } = useUiStore.getState();
    let currentStatus: TerminalStatus = 'connecting';
    const updateStatus = (next: TerminalStatus) => {
      currentStatus = next;
      setStatus(next);
    };
    updateStatus('connecting');

    const terminal = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 14,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: neutrals.base,
        foreground: neutrals.text,
        cursor: accents.online,
        cursorAccent: neutrals.base,
        selectionBackground: 'rgba(143, 227, 255, 0.25)',
        cyan: accents.online,
        brightCyan: neutrals.textBright,
        yellow: accents.degraded,
        red: accents.alert,
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    // GPU renderer only on real GPUs; the DOM renderer is faster on software WebGL.
    if (hasHardwareWebGL()) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose()); // falls back to the DOM renderer
        terminal.loadAddon(webgl);
      } catch {
        // WebGL unavailable: the DOM renderer is used.
      }
    }
    fit.fit();
    terminal.focus();

    // Leaving: an explicit chord, never Esc.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && isExitChord(event)) {
        exitTerminal();
        return false;
      }
      return true;
    });

    if (isDemo || browserDemo) {
      updateStatus('demo');
      terminal.write(
        `${DIM}Demo data: there is no real server behind this tower, so there is no shell.${RESET}\r\n` +
          `${DIM}Press Ctrl+Shift+X to return to the city.${RESET}\r\n`,
      );
      return () => terminal.dispose();
    }

    let returnTimer: ReturnType<typeof setTimeout> | undefined;
    const connection = openTerminalSession(
      hostId,
      { cols: terminal.cols, rows: terminal.rows },
      {
        onOutput: (bytes) => terminal.write(bytes),
        onControl: (message) => {
          if (message.type === 'ready') {
            updateStatus('connected');
          } else if (message.type === 'exit') {
            updateStatus('ended');
            const how = message.signal ? `signal ${message.signal}` : `code ${message.code ?? '?'}`;
            terminal.write(`\r\n${DIM}[session ended, ${how}]${RESET}\r\n`);
            returnTimer = setTimeout(exitTerminal, RETURN_AFTER_EXIT_MS);
          } else {
            updateStatus('failed');
            terminal.write(
              `\r\n${RED}${message.message}${RESET}\r\n${DIM}Enter to retry · Ctrl+Shift+X back to the city${RESET}\r\n`,
            );
          }
        },
        onUnexpectedClose: () => {
          updateStatus('disconnected');
          terminal.write(
            `\r\n${RED}[connection lost]${RESET} ${DIM}Enter to reconnect · Ctrl+Shift+X back to the city${RESET}\r\n`,
          );
        },
      },
    );

    const input = terminal.onData((data) => {
      if (currentStatus === 'connected') connection.sendInput(data);
      else if (data === '\r' && (currentStatus === 'disconnected' || currentStatus === 'failed')) {
        setAttempt((value) => value + 1);
      }
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fit.fit();
        connection.resize(terminal.cols, terminal.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      clearTimeout(returnTimer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      input.dispose();
      connection.close();
      terminal.dispose();
    };
  }, [hostId, attempt, isDemo, browserDemo]);

  if (!hostId) return null;

  return (
    <motion.section
      className="terminal-view"
      aria-label={`Terminal on ${host?.name ?? hostId}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
    >
      <header className="terminal-header">
        <span className={`terminal-status is-${status}`}>{STATUS_LABEL[status]}</span>
        <span className="terminal-title">
          {host ? `${host.user}@${host.name}` : hostId}
          {host && (
            <span className="terminal-address">
              {' '}
              · {host.address}:{host.port}
            </span>
          )}
        </span>
        <button type="button" onClick={() => useUiStore.getState().exitTerminal()}>
          Back to the city <kbd>Ctrl</kbd>
          <kbd>Shift</kbd>
          <kbd>X</kbd>
        </button>
      </header>
      <div ref={containerRef} className="terminal-body" data-testid="terminal" />
    </motion.section>
  );
}

/**
 * Grid-line dissolve shown while diving in or surfacing. Pure UI state: it
 * says "you are entering / leaving the machine", never anything about health.
 */
export function DiveOverlay() {
  const phase = useUiStore((store) => store.terminal?.phase ?? null);
  if (phase !== 'diving' && phase !== 'surfacing') return null;
  return <div className={`dive-overlay is-${phase}`} aria-hidden="true" />;
}
