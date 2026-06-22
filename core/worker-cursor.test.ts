import { test, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursor, writeCursor, resolveStartCursor } from "./worker-cursor.ts";

test("writeCursor/readCursor round-trip atomically (no leftover temp file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-cursor-"));
  try {
    const path = join(dir, "worker-cursor.json");
    expect(readCursor(path)).toBeNull(); // absent

    writeCursor(path, 42);
    expect(readCursor(path)).toBe(42);
    expect(existsSync(`${path}.tmp`)).toBe(false); // temp renamed away

    writeCursor(path, 99); // overwrite
    expect(readCursor(path)).toBe(99);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCursor returns null for malformed content", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-cursor-"));
  try {
    const path = join(dir, "c.json");
    rmSync(path, { force: true });
    expect(readCursor(path)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStartCursor: first run uses newest event id, restart continues from saved", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-cursor-"));
  try {
    const path = join(dir, "worker-cursor.json");
    // First run (no file): start from MAX(events.id) so the backlog is skipped.
    expect(resolveStartCursor(path, 100)).toBe(100);

    // After persisting, a restart resumes from the saved value, ignoring newest id.
    writeCursor(path, 100);
    expect(resolveStartCursor(path, 250)).toBe(100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
