import { AppSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from '@app/shared';
import type { AppDatabase } from './database';

/**
 * App settings edited in the Settings panel (history retention). Kept in
 * the local database as JSON. Per-host configuration (names, districts,
 * thresholds) stays in hosts.yaml, so the file remains the source of truth.
 */
export class AppSettingsStore {
  constructor(private readonly db: AppDatabase) {}

  load(): AppSettings {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'app'").get() as
      { value: string } | undefined;
    if (!row) return DEFAULT_APP_SETTINGS;
    const parsed = AppSettingsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : DEFAULT_APP_SETTINGS;
  }

  save(settings: AppSettings): AppSettings {
    const valid = AppSettingsSchema.parse(settings);
    this.db
      .prepare(
        "INSERT INTO app_settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(valid));
    return valid;
  }
}
