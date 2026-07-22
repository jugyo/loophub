import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { logWorkflowWatcher } from "./workflow-watcher-log.ts";

const homes: string[] = [];

afterEach(() => {
  const home = homes.pop();
  if (home) rmSync(home, { recursive: true, force: true });
  delete process.env.LOOPHUB_HOME;
});

test("writes JSON lines under the workflow watcher log directory", () => {
  const home = mkdtempSync(join(tmpdir(), "lh-workflow-watcher-log-"));
  homes.push(home);
  process.env.LOOPHUB_HOME = home;

  logWorkflowWatcher({
    event: "started",
    repo: "jugyo/loophub",
    run: 42,
    cursor: 7,
  });
  logWorkflowWatcher({
    event: "delivered",
    repo: "jugyo/loophub",
    run: 42,
    cursor: 8,
    next_command:
      "lh workflow watch --repo 'jugyo/loophub' --run 42 --since 8 --json",
  });

  const lines = readFileSync(
    join(home, "logs", "workflow-watch", "jugyo", "loophub", "run-42.log"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines).toEqual([
    expect.objectContaining({ event: "started", cursor: 7 }),
    expect.objectContaining({ event: "delivered", cursor: 8 }),
  ]);
});
