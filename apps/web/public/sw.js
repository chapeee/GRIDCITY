/* global self, URL */
/*
 * GRIDCITY service worker: shows alerts the server pushes (Web Push), even
 * when no GRIDCITY tab is open. It caches nothing and never touches requests.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : 'GRIDCITY' };
  }
  const level = data.level || 'test';
  event.waitUntil(
    self.registration.showNotification(data.title || 'GRIDCITY', {
      body: data.body || '',
      tag: data.tag || 'gridcity',
      // A new state of the same target replaces the old card and still alerts.
      renotify: Boolean(data.tag),
      // Offline stays on screen until someone sees it.
      requireInteraction: level === 'offline' || level === 'attack',
      silent: level === 'recovered',
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.startsWith(self.location.origin));
      if (open) return open.focus();
      return self.clients.openWindow(target);
    }),
  );
});
