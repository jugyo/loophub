// Worker consumer bookmark. The cursor is the worker's bookkeeping, NOT domain data, so it
// lives in a JSON file outside the SQLite schema (issue #52): a worker can be swapped or
// re-implemented without touching the DB. Writes are atomic (temp file + rename) so a crash
// mid-write never leaves a truncated cursor.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

interface CursorFile {
  cursor: number;
}

/** Read the persisted cursor, or null when the file is absent/unreadable/malformed. */
export function readCursor(path: string): number | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as CursorFile;
    return typeof data?.cursor === "number" ? data.cursor : null;
  } catch {
    return null;
  }
}

/** Atomically persist the cursor (write temp, then rename over the target). */
export function writeCursor(path: string, cursor: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ cursor } satisfies CursorFile));
  renameSync(tmp, path);
}

// Starting cursor on worker boot: continue from the persisted value when present, otherwise
// start from the newest event id so the backlog is skipped — the worker processes "from now
// on", not history (issue #52).
export function resolveStartCursor(
  path: string,
  newestEventId: number,
): number {
  const saved = readCursor(path);
  return saved != null ? saved : newestEventId;
}
