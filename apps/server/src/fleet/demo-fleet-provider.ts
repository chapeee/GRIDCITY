import {
  createDemoFleet,
  createUnknownHostState,
  type DemoFleet,
  type Host,
  type HostState,
  type StatusThresholds,
} from '@app/shared';
import type { FleetListener, FleetProvider } from './fleet-provider';

/**
 * The shared demo fleet, served by the server (`DATA_MODE=demo`). Announced
 * as demo data, so clients always show the DEMO DATA badge. No SSH at all.
 */
export class DemoFleetProvider implements FleetProvider {
  readonly dataMode = 'demo' as const;
  private readonly fleet: DemoFleet;
  private states: HostState[];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { hostCount?: number; seed?: number; thresholds?: StatusThresholds } = {}) {
    this.fleet = createDemoFleet({ ...options, startedAt: Date.now() });
    this.states = this.fleet.hosts.map((host) => createUnknownHostState(host.id));
  }

  get hosts(): readonly Host[] {
    return this.fleet.hosts;
  }

  get thresholds(): StatusThresholds {
    return this.fleet.thresholds;
  }

  start(listener: FleetListener): void {
    const poll = () => {
      this.states = this.fleet.tick(Date.now());
      listener({ type: 'changed' });
    };
    poll();
    this.timer = setInterval(poll, this.fleet.thresholds.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  currentStates(): HostState[] {
    return this.states;
  }
}
