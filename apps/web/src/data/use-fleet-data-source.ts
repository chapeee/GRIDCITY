import { useEffect } from 'react';
import { createDemoDataSource } from './demo-source';
import { parseDemoOptions, STATIC_DEMO_HOST_COUNT } from './demo-options';
import { useFleetStore } from './fleet-store';
import { useServerLink } from './server-link';
import { createWebSocketSource } from './websocket-source';

/**
 * Starts the data source for this page:
 * - default: the local server over WebSocket (the server decides real or demo
 *   data and says so in `hello`);
 * - `?source=demo`: the demo fleet simulated in the browser, for working on
 *   the world without a server (always badged DEMO DATA). The static build
 *   hosted on GitHub Pages always does this.
 */
export function useFleetDataSource(): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const link = useServerLink.getState();
    const receive = useFleetStore.getState().receive;

    if (__STATIC_DEMO__ || params.get('source') === 'demo') {
      link.setSource('browser-demo');
      link.setState('open');
      const options = parseDemoOptions(window.location.search);
      if (__STATIC_DEMO__ && !params.has('hosts')) options.hostCount = STATIC_DEMO_HOST_COUNT;
      return createDemoDataSource(options, __PROJECT_NAME__).start(receive);
    }

    link.setSource('server');
    return createWebSocketSource({ onLinkChange: link.setState }).start(receive);
  }, []);
}
