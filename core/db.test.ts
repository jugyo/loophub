import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before db.ts runs its import-time setup (see store.test.ts).
const HOME = mkdtempSync(join(tmpdir(), "lh-db-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let D: typeof import("./db.ts");

beforeAll(async () => {
  D = await import("./db.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("busy_timeout is set so concurrent writers wait instead of failing immediately", () => {
  // A non-zero busy_timeout is what makes a write block (up to N ms) for another
  // process's write lock rather than throwing SQLITE_BUSY ("database is locked").
  const row = D.db.query("PRAGMA busy_timeout").get() as { timeout: number };
  expect(row.timeout).toBe(5000);
});

test("WAL journal mode is preserved alongside busy_timeout", () => {
  const row = D.db.query("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  expect(row.journal_mode.toLowerCase()).toBe("wal");
});
