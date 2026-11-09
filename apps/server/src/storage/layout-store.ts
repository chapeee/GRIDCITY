import type { DataMode, SlotAssignments } from '@app/shared';
import type { AppDatabase } from './database';

/** Persists sticky layout slots, separately per data mode (demo never mixes with real). */
export class LayoutStore {
  constructor(private readonly db: AppDatabase) {}

  load(dataMode: DataMode): SlotAssignments {
    const rows = this.db
      .prepare('SELECT host_id AS hostId, slot FROM layout_slots WHERE data_mode = ?')
      .all(dataMode) as { hostId: string; slot: number }[];
    return Object.fromEntries(rows.map((row) => [row.hostId, row.slot]));
  }

  /** Replaces all slots for the data mode (removed hosts free their slots). */
  save(dataMode: DataMode, slots: SlotAssignments): void {
    const remove = this.db.prepare('DELETE FROM layout_slots WHERE data_mode = ?');
    const insert = this.db.prepare(
      'INSERT INTO layout_slots (data_mode, host_id, slot) VALUES (?, ?, ?)',
    );
    this.db.transaction(() => {
      remove.run(dataMode);
      for (const [hostId, slot] of Object.entries(slots)) insert.run(dataMode, hostId, slot);
    })();
  }
}
