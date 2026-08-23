import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "#loophub-test";
import { setProcessSpawnerForTests } from "../core/process.ts";

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

test("usage sync rejects stderr-only maxBuffer overflow even with exit code 0", async () => {
  const kill = vi.fn();
  const restore = setProcessSpawnerForTests(
    () =>
      ({
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  synced: 0,
                  skipped: 0,
                  missing: 0,
                  sessions: [],
                }),
              ),
            );
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill,
      }) as unknown as ReturnType<
        typeof import("../core/process.ts").spawnProcess
      >,
  );

  try {
    const { runUsageSyncSubprocess } = await import("./usage-sync.ts");
    await expect(runUsageSyncSubprocess()).rejects.toThrow(
      "usage sync subprocess exceeded max buffer",
    );
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  } finally {
    restore();
  }
});
