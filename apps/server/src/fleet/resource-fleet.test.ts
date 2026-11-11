import { DEFAULT_RESOURCE_THRESHOLDS, type Resource, type ServerMessage } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { ResourceConfigSchema, type ResourceConfig } from '../config/resources-file';
import { healthSample, metric, type Connector, type PollOutcome } from '../connectors/connector';
import { AuditLog } from '../storage/audit-log';
import { openDatabase } from '../storage/database';
import { DemoFleetProvider } from './demo-fleet-provider';
import { ResourceFleet } from './resource-fleet';
import { StateHub } from './state-hub';

/** A connector whose resources and outcomes the test controls. */
function fakeConnector(config: ResourceConfig) {
  const state = {
    resources: [
      {
        id: config.id,
        name: config.id,
        kind: config.kind,
        engine: 'PostgreSQL',
        district: 'Databases',
        tags: [],
        target: 'db:5432',
        sourceId: config.id,
        dependsOn: [],
      },
    ] as Resource[],
    next: [] as PollOutcome[],
  };
  const connector: Connector = {
    config,
    resources: () => state.resources,
    poll: async () => state.next,
    close: async () => undefined,
  };
  return { connector, state };
}

const pg = ResourceConfigSchema.parse({
  kind: 'postgres',
  id: 'orders',
  host: 'db',
  user: 'u',
}) as ResourceConfig;
const up = (id: string, used = 5): PollOutcome => ({
  resourceId: id,
  ok: true,
  sample: healthSample({ connections: { used, max: 100 } }),
  metrics: [metric('connections', 'Connections', 'count', used)],
});

describe('ResourceFleet + StateHub', () => {
  it('serves resources in the snapshot, sends diffs, re-snapshots on discovery and audits transitions', async () => {
    const fake = fakeConnector(pg);
    const db = openDatabase(':memory:');
    const audit = new AuditLog(db);
    const fleet = new ResourceFleet({
      configs: [pg],
      thresholds: DEFAULT_RESOURCE_THRESHOLDS,
      createConnector: () => fake.connector,
      audit,
    });
    const hub = new StateHub({
      provider: new DemoFleetProvider({ hostCount: 2 }),
      resources: fleet,
      projectName: 'example',
      staleCheckIntervalMs: 60_000,
    });
    const received: ServerMessage[] = [];
    hub.subscribe((message) => received.push(message));

    const snapshot = received.find((m) => m.type === 'snapshot');
    expect(snapshot).toMatchObject({
      resources: [{ id: 'orders' }],
      resourceStates: [{ resourceId: 'orders', status: 'unknown' }],
    });
    if (snapshot?.type === 'snapshot') expect(snapshot.layoutSlots.orders).toBe(0);

    // First poll: online, sent as a resourceStates diff.
    fake.state.next = [up('orders')];
    hub.start(); // the fleet polls once right away
    await new Promise((resolve) => setTimeout(resolve, 20));
    const diff = received.filter((m) => m.type === 'resourceStates').at(-1);
    expect(diff).toMatchObject({ states: [{ resourceId: 'orders', status: 'online' }] });

    // Failure: offline, audited once.
    fake.state.next = [{ resourceId: 'orders', ok: false, error: 'ECONNREFUSED' }];
    await fleet.pollAll();
    await fleet.pollAll();
    expect(
      audit
        .recent()
        .map((e) => e.kind)
        .filter((k) => k.startsWith('resource_')),
    ).toEqual(['resource_unreachable', 'resource_reachable']);

    // Discovery adds a resource: everyone gets a fresh snapshot with a slot for it.
    received.length = 0;
    fake.state.resources = [
      ...fake.state.resources,
      { ...fake.state.resources[0]!, id: 'orders-2', name: 'orders-2' },
    ];
    fake.state.next = [up('orders'), up('orders-2')];
    await fleet.pollAll();
    const next = received.find((m) => m.type === 'snapshot');
    expect(next?.type === 'snapshot' && next.layoutSlots['orders-2']).toBe(1);
    hub.stop();
    db.close();
  });
});
