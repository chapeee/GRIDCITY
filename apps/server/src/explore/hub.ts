import { isManageable, isSqlKind, type ManageMode } from '@app/shared';
import { loadResourcesFile, type ResourceConfig } from '../config/resources-file';
import type { ConnectorContext } from '../connectors/connector';
import { MongoExplorer } from './mongo';
import { RedisExplorer } from './redis';
import { S3Explorer } from './s3';
import { createSqlExplorer, ExploreError, type SqlExplorer } from './sql';

export type Explorer =
  | { kind: 'sql'; explorer: SqlExplorer }
  | { kind: 'mongodb'; explorer: MongoExplorer }
  | { kind: 'redis'; explorer: RedisExplorer }
  | { kind: 's3'; explorer: S3Explorer };

interface Session {
  explorer: Explorer;
  /** The resources.yaml entry it was opened with (connection settings and mode). */
  config: ResourceConfig;
  fingerprint: string;
  lastUsed: number;
}

/** Sessions with no request for this long are closed (connections released). */
const IDLE_MS = 3 * 60_000;

/**
 * One Manage session per resources.yaml entry, separate from the monitoring
 * connectors (which stay read-only and lightweight). A session is reopened
 * when its entry changes, so a new password or host takes effect at once; the
 * mode (read/write) is read from the entry on every request.
 */
export class ExploreHub {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly resourcesFile: string,
    private readonly context: ConnectorContext,
  ) {
    this.timer = setInterval(() => void this.sweep(), 30_000);
    this.timer.unref();
  }

  /** The entry and its open explorer. Throws a 404 for unknown or unmanageable ids. */
  async get(id: string): Promise<{ config: ResourceConfig; explorer: Explorer; mode: ManageMode }> {
    const config = await this.entry(id);
    const fingerprint = JSON.stringify({ ...config, manage: undefined });
    let session = this.sessions.get(config.id);
    if (session && session.fingerprint !== fingerprint) {
      this.sessions.delete(config.id);
      await closeExplorer(session.explorer);
      session = undefined;
    }
    if (!session) {
      session = { explorer: this.open(config), config, fingerprint, lastUsed: Date.now() };
      this.sessions.set(config.id, session);
    }
    session.config = config;
    session.lastUsed = Date.now();
    return { config, explorer: session.explorer, mode: modeOf(config) };
  }

  async entry(id: string): Promise<ResourceConfig> {
    const loaded = await loadResourcesFile(this.resourcesFile);
    if (!loaded.ok) throw new ExploreError('resources.yaml has errors: fix them first', 409);
    const config = loaded.config.resources.find((r) => r.id === id);
    if (!config) throw new ExploreError(`no resource "${id}"`, 404);
    if (!isManageable(config.kind))
      throw new ExploreError(`${config.kind} has no Manage view`, 404);
    return config;
  }

  private open(config: ResourceConfig): Explorer {
    // The mode is looked up live, so switching Changes on/off needs no reconnect.
    const mode = () => modeOf(this.sessions.get(config.id)?.config ?? config);
    if (isSqlKind(config.kind)) {
      return { kind: 'sql', explorer: createSqlExplorer(config as never, this.context, mode) };
    }
    switch (config.kind) {
      case 'mongodb':
        return { kind: 'mongodb', explorer: new MongoExplorer(config, this.context, mode) };
      case 'redis':
        return { kind: 'redis', explorer: new RedisExplorer(config, this.context, mode) };
      case 's3':
        return { kind: 's3', explorer: new S3Explorer(config, this.context, mode) };
      default:
        throw new ExploreError(`${config.kind} has no Manage view`, 404);
    }
  }

  /** Forget a session (after the entry was removed or its credentials changed). */
  async drop(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await closeExplorer(session.explorer);
  }

  private async sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > IDLE_MS) await this.drop(id);
    }
  }

  async close() {
    clearInterval(this.timer);
    await Promise.all([...this.sessions.keys()].map((id) => this.drop(id)));
  }
}

export const modeOf = (config: ResourceConfig): ManageMode =>
  (config as { manage?: ManageMode }).manage === 'write' ? 'write' : 'read';

async function closeExplorer(explorer: Explorer) {
  await explorer.explorer.close().catch(() => undefined);
}
