import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-usage-sync-subprocess-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "test.db");

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("usage sync runs in a DB-capable subprocess and returns JSON", async () => {
  const { runUsageSyncSubprocess } = await import("./usage-sync.ts");

  await expect(runUsageSyncSubprocess()).resolves.toEqual({
    synced: 0,
    skipped: 0,
    missing: 0,
    sessions: [],
  });
});
