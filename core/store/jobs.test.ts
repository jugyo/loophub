import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-jobs-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "test.db");

let jobs: typeof import("./jobs.ts");

beforeAll(async () => {
  jobs = await import("./jobs.ts");
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("enqueue is idempotent and claimed jobs finish visibly", () => {
  const first = jobs.enqueue({
    type: "shell",
    dedupeKey: "event:1:shell",
    params: { command: "true" },
  });
  expect(
    jobs.enqueue({
      type: "shell",
      dedupeKey: "event:1:shell",
      params: { command: "false" },
    }),
  ).toBe(first);

  const claimed = jobs.claimNext();
  expect(claimed).toMatchObject({
    id: first,
    type: "shell",
    status: "running",
    dedupe_key: "event:1:shell",
  });
  expect(jobs.claimNext()).toBeNull();

  jobs.finish(first, { status: "done", result: { exit_code: 0 } });
  expect(jobs.claimNext()).toBeNull();
});
