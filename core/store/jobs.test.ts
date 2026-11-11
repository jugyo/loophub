import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

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

test("failStale fails only running jobs whose heartbeat stopped, without requeueing them", async () => {
  const stale = jobs.enqueue({
    type: "shell",
    dedupeKey: "stale",
    params: { command: "true" },
  });
  const fresh = jobs.enqueue({
    type: "shell",
    dedupeKey: "fresh",
    params: { command: "true" },
  });
  expect(jobs.claimNext()?.id).toBe(stale);
  expect(jobs.claimNext()?.id).toBe(fresh);
  const queued = jobs.enqueue({
    type: "shell",
    dedupeKey: "queued",
    params: { command: "true" },
  });
  jobs.heartbeat(fresh);
  const { db } = await import("../db.ts");
  db.run("UPDATE jobs SET heartbeat_at = ? WHERE id = ?", [
    "2000-01-01T00:00:00Z",
    stale,
  ]);

  // A job the caller is still running is never failed, however old its heartbeat.
  expect(
    jobs.failStale("2001-01-01T00:00:00Z", [stale], "stale heartbeat"),
  ).toEqual([]);
  const failed = jobs.failStale("2001-01-01T00:00:00Z", [], "stale heartbeat");
  expect(failed.map((job) => job.id)).toEqual([stale]);
  const status = (id: number) =>
    db.query("SELECT status, error FROM jobs WHERE id = ?").get(id);
  expect(status(stale)).toEqual({ status: "failed", error: "stale heartbeat" });
  expect(status(fresh)).toMatchObject({ status: "running" });
  expect(status(queued)).toMatchObject({ status: "queued" });

  // A late finish from a process that was still alive cannot overwrite the failure.
  jobs.finish(stale, { status: "done" });
  expect(status(stale)).toMatchObject({ status: "failed" });
  expect(jobs.claimNext()?.id).toBe(queued);
});
