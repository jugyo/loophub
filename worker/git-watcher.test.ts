import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-git-watcher-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "test.db");

let W: typeof import("./git-watcher.ts");

beforeAll(async () => {
  W = await import("./git-watcher.ts");
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("runs local git observation loops independently and stops them", async () => {
  vi.useFakeTimers();
  const pullSweep = vi.fn(async () => []);
  const conflictSweep = vi.fn(async () => ({ checked: 2, emitted: 1 }));
  const watcher = W.startGitWatcher({
    pullSweepMs: 10,
    conflictSweepMs: 20,
    pullSweep,
    conflictSweep,
  });

  await vi.advanceTimersByTimeAsync(20);
  expect(pullSweep).toHaveBeenCalledTimes(2);
  expect(conflictSweep).toHaveBeenCalledTimes(1);

  watcher.stop();
  await vi.advanceTimersByTimeAsync(40);
  expect(pullSweep).toHaveBeenCalledTimes(2);
  expect(conflictSweep).toHaveBeenCalledTimes(1);
});

test("zero intervals disable observation loops", async () => {
  vi.useFakeTimers();
  const pullSweep = vi.fn(async () => []);
  const conflictSweep = vi.fn(async () => ({ checked: 0, emitted: 0 }));
  const watcher = W.startGitWatcher({
    pullSweepMs: 0,
    conflictSweepMs: 0,
    pullSweep,
    conflictSweep,
  });

  await vi.advanceTimersByTimeAsync(100);
  expect(pullSweep).not.toHaveBeenCalled();
  expect(conflictSweep).not.toHaveBeenCalled();
  watcher.stop();
});
