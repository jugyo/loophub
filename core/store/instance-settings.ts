import { db, now } from "../db.ts";

export function getInstanceSetting(key: string): string | null {
  const row = db
    .query("SELECT value FROM instance_settings WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setInstanceSetting(key: string, value: string): void {
  db.run(
    `INSERT INTO instance_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now()],
  );
}
