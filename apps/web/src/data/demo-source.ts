import {
  assignSlots,
  createDemoFleet,
  createDemoResources,
  createUnknownHostState,
  DEFAULT_STATUS_THRESHOLDS,
  PROTOCOL_VERSION,
} from '@app/shared';
import type { DemoOptions } from './demo-options';
import type { HostDataSource } from './host-data-source';

/** Delay before the first poll, so the city visibly starts out "unknown". */
const FIRST_POLL_DELAY_MS = 600;

/**
 * Runs the shared demo fleet in the browser and speaks the same protocol a
 * real server does. It always announces `dataMode: 'demo'`.
 */
export function createDemoDataSource(options: DemoOptions, projectName: string): HostDataSource {
  return {
    start(listener) {
      const thresholds = { ...DEFAULT_STATUS_THRESHOLDS, pollIntervalMs: options.pollIntervalMs };
      const fleet = createDemoFleet({
        seed: options.seed,
        hostCount: options.hostCount,
        thresholds,
        startedAt: Date.now(),
      });

      listener({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        dataMode: 'demo',
        projectName,
        thresholds,
      });
      const resources = createDemoResources({ seed: options.seed, startedAt: Date.now() });
      listener({
        type: 'snapshot',
        hosts: [...fleet.hosts],
        states: fleet.hosts.map((host) => createUnknownHostState(host.id)),
        // Demo data is deterministic, so fresh assignments are stable across reloads.
        layoutSlots: assignSlots([...fleet.hosts, ...resources.resources], {}),
        resources: resources.resources,
        resourceStates: resources.tick(Date.now()),
      });

      const poll = () => {
        const now = Date.now();
        listener({ type: 'hostStates', states: fleet.tick(now) });
        listener({ type: 'resourceStates', states: resources.tick(now) });
      };
      let interval: ReturnType<typeof setInterval> | undefined;
      const firstPoll = setTimeout(() => {
        poll();
        interval = setInterval(poll, options.pollIntervalMs);
      }, FIRST_POLL_DELAY_MS);

      return () => {
        clearTimeout(firstPoll);
        clearInterval(interval);
      };
    },
  };
}
