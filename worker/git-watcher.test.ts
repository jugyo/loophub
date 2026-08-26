import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
  vi,
} from "#loophub-test";

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

test("local git observation loop を実行して停止する", async () => {
  vi.useFakeTimers();
  const pullSweep = vi.fn(async () => []);
  const watcher = W.startGitWatcher({
    pullSweepMs: 10,
    pullSweep,
  });

  await vi.advanceTimersByTimeAsync(20);
  expect(pullSweep).toHaveBeenCalledTimes(2);

  watcher.stop();
  await vi.advanceTimersByTimeAsync(40);
  expect(pullSweep).toHaveBeenCalledTimes(2);
});

test("zero interval では observation loop を無効にする", async () => {
  vi.useFakeTimers();
  const pullSweep = vi.fn(async () => []);
  const watcher = W.startGitWatcher({
    pullSweepMs: 0,
    pullSweep,
  });

  await vi.advanceTimersByTimeAsync(100);
  expect(pullSweep).not.toHaveBeenCalled();
  watcher.stop();
});
