/**
 * The GitHub Pages demo has no server. Calls to `/api/*` would hit the Pages
 * host and come back as HTML 404s; instead they get a clear JSON error that the
 * panels already know how to show.
 */
export const STATIC_DEMO_MESSAGE =
  'Not available in the online demo. Run `npx gridcity demo` to try this on your machine.';

export function installStaticDemoApi(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: STATIC_DEMO_MESSAGE }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return realFetch(input, init);
  };
}
