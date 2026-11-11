import type { HostStatus } from '@app/shared';
import { useEffect } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { useUiStore } from './ui-store';

/**
 * Desktop notifications when a server or resource goes offline, degraded or
 * recovers. Off by default; Settings asks the browser for permission. The
 * first status seen after connecting is not news, and demo data never
 * notifies (it is simulated trouble).
 */
export function useAlerts(): void {
  const enabled = useUiStore((store) => store.notificationsEnabled);

  useEffect(() => {
    if (!enabled || typeof Notification === 'undefined') return;
    const last = new Map<string, HostStatus>();
    let primed = false;

    const check = () => {
      const { states, resourceStates, hosts, resources, dataMode, projectName } =
        useFleetStore.getState();
      if (dataMode !== 'real') return;
      const nameOf = (id: string) =>
        hosts.find((h) => h.id === id)?.name ?? resources.find((r) => r.id === id)?.name ?? id;
      const current: [string, HostStatus, string | null][] = [
        ...Object.values(states).map(
          (s) => [s.hostId, s.status, s.statusReason] as [string, HostStatus, string | null],
        ),
        ...Object.values(resourceStates).map(
          (s) => [s.resourceId, s.status, s.statusReason] as [string, HostStatus, string | null],
        ),
      ];
      for (const [id, status, reason] of current) {
        if (status === 'unknown') continue;
        const previous = last.get(id);
        last.set(id, status);
        if (!primed || previous === undefined || previous === status) continue;
        const worse = status === 'offline' || status === 'degraded';
        const better = status === 'online' && (previous === 'offline' || previous === 'degraded');
        if (!worse && !better) continue;
        if (Notification.permission !== 'granted') continue;
        const title = `${nameOf(id)} is ${status}`;
        new Notification(title, {
          body: worse ? (reason ?? '') : `back online (was ${previous})`,
          tag: `${projectName ?? 'city'}:${id}`,
          silent: !worse,
        });
      }
      primed = true;
    };

    check();
    const unsubscribe = useFleetStore.subscribe(check);
    return unsubscribe;
  }, [enabled]);
}

/** Asks the browser once; returns the resulting permission. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}
