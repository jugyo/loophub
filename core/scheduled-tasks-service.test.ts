import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-sched-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-sched-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/sched" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("create normalizes times (dedupe + sort) and resolves default model/effort", () => {
  const task = svc.scheduledTasks.create("me/sched", {
    title: "Nightly",
    prompt: "do the thing",
    agent: "claude-code",
    times: ["18:00", "09:00", "09:00"],
  });
  expect(task.id).toBeGreaterThan(0);
  expect(task.times).toEqual(["09:00", "18:00"]);
  // No override => the per-agent application default is surfaced for the UI placeholder.
  expect(task.model).toBeNull();
  expect(task.effort).toBeNull();
  expect(task.default_model).toBe("opus");
  expect(task.default_effort).toBe("medium");

  const listed = svc.scheduledTasks.list("me/sched");
  expect(listed.map((t) => t.id)).toContain(task.id);
});

test("invalid agent and time are rejected", () => {
  expect(() =>
    svc.scheduledTasks.create("me/sched", {
      title: "x",
      prompt: "p",
      agent: "gpt" as never,
      times: [],
    }),
  ).toThrow(/agent must be/);
  expect(() =>
    svc.scheduledTasks.create("me/sched", {
      title: "x",
      prompt: "p",
      agent: "codex",
      times: ["9:00"],
    }),
  ).toThrow(/invalid time/);
  expect(() =>
    svc.scheduledTasks.create("me/sched", {
      title: "x",
      prompt: "p",
      agent: "codex",
      times: ["24:00"],
    }),
  ).toThrow(/invalid time/);
});

test("update patches only provided fields; delete removes it", () => {
  const task = svc.scheduledTasks.create("me/sched", {
    title: "Editable",
    prompt: "p1",
    agent: "codex",
    times: ["10:00"],
    model: "gpt-5.5-mini",
    effort: "high",
  });
  expect(task.model).toBe("gpt-5.5-mini");
  expect(task.effort).toBe("high");

  const updated = svc.scheduledTasks.update("me/sched", task.id, {
    prompt: "p2",
    model: null, // explicit clear => falls back to default
  });
  expect(updated.title).toBe("Editable"); // untouched
  expect(updated.prompt).toBe("p2");
  expect(updated.model).toBeNull();
  expect(updated.effort).toBe("high"); // untouched

  svc.scheduledTasks.delete("me/sched", task.id);
  expect(() => svc.scheduledTasks.get("me/sched", task.id)).toThrow();
});

test("get returns the task with its run log", () => {
  const task = svc.scheduledTasks.create("me/sched", {
    title: "WithRuns",
    prompt: "p",
    agent: "claude-code",
    times: [],
  });
  const repo = S.getRepo("me", "sched")!;
  // Simulate a completed fire (avoid spawning a real herdr tab in the test).
  const run = S.createScheduledTaskRun({
    taskId: task.id,
    repoId: repo.id,
    trigger: "manual",
    scheduledTime: null,
    fireKey: null,
  });
  S.finishScheduledTaskRun(run.id, {
    status: "success",
    herdrTabId: "w1:t2",
    herdrPaneId: "w1:p1",
  });

  const detail = svc.scheduledTasks.get("me/sched", task.id);
  expect(detail.runs).toHaveLength(1);
  expect(detail.runs[0].status).toBe("success");
  expect(detail.runs[0].herdr_tab_id).toBe("w1:t2");
  expect(detail.runs[0].trigger).toBe("manual");
});

test("scheduled runs dedupe per task+fire_key (once-per-day guard)", () => {
  const task = svc.scheduledTasks.create("me/sched", {
    title: "Daily",
    prompt: "p",
    agent: "claude-code",
    times: ["08:00"],
  });
  const repo = S.getRepo("me", "sched")!;
  const fireKey = "2026-01-01T08:00";
  S.createScheduledTaskRun({
    taskId: task.id,
    repoId: repo.id,
    trigger: "scheduled",
    scheduledTime: "08:00",
    fireKey,
  });
  expect(S.scheduledRunExists(task.id, fireKey)).toBe(true);
  // A second insert with the same fire_key violates the UNIQUE index and throws — the store-level
  // guard the sweep relies on.
  expect(() =>
    S.createScheduledTaskRun({
      taskId: task.id,
      repoId: repo.id,
      trigger: "scheduled",
      scheduledTime: "08:00",
      fireKey,
    }),
  ).toThrow();
});

function clearTasks(repoName: string) {
  for (const t of svc.scheduledTasks.list(repoName))
    svc.scheduledTasks.delete(repoName, t.id);
}

test("sweep skips future, past-grace, and already-fired times without launching", () => {
  // The sweep scans every task in the DB, so clear the tasks left by earlier tests first — a
  // leftover task with a due-within-grace time would otherwise trigger a real herdr launch here.
  clearTasks("me/sched");

  // now = 09:05. Three tasks that must all be skipped, so the sweep never reaches a herdr launch:
  //   - future: only time 23:59 is later than now.
  //   - pastGrace: 08:00 is 65 min before now, past FIRE_GRACE_MINUTES (10) — the catch-up guard.
  //   - alreadyFired: 09:00 is within grace, but a run row for today's slot already exists (dedup).
  const now = new Date(2026, 0, 1, 9, 5, 0);
  const futureTask = svc.scheduledTasks.create("me/sched", {
    title: "Future",
    prompt: "p",
    agent: "claude-code",
    times: ["23:59"],
  });
  const pastGraceTask = svc.scheduledTasks.create("me/sched", {
    title: "PastGrace",
    prompt: "p",
    agent: "claude-code",
    times: ["08:00"],
  });
  const firedTask = svc.scheduledTasks.create("me/sched", {
    title: "AlreadyFired",
    prompt: "p",
    agent: "claude-code",
    times: ["09:00"],
  });
  const repo = S.getRepo("me", "sched")!;
  S.createScheduledTaskRun({
    taskId: firedTask.id,
    repoId: repo.id,
    trigger: "scheduled",
    scheduledTime: "09:00",
    fireKey: "2026-01-01T09:00",
  });

  return svc.scheduledTasks.sweep(now).then((result) => {
    expect(result.fired).toBe(0);
    expect(S.listScheduledTaskRuns(futureTask.id)).toHaveLength(0);
    expect(S.listScheduledTaskRuns(pastGraceTask.id)).toHaveLength(0);
    expect(S.listScheduledTaskRuns(firedTask.id)).toHaveLength(1); // only the pre-seeded one
  });
});

test("sweep skips tasks whose repo is archived (matches the Run now guard)", async () => {
  clearTasks("me/sched");
  // A due-within-grace time (09:00, now 09:05) that would fire if the repo were active — so an empty
  // run list proves the archived-repo skip, not the grace guard, stopped it.
  const task = svc.scheduledTasks.create("me/sched", {
    title: "OnArchived",
    prompt: "p",
    agent: "claude-code",
    times: ["09:00"],
  });
  svc.repos.setArchived("me/sched", true);
  try {
    const result = await svc.scheduledTasks.sweep(
      new Date(2026, 0, 1, 9, 5, 0),
    );
    expect(result.fired).toBe(0);
    expect(S.listScheduledTaskRuns(task.id)).toHaveLength(0);
  } finally {
    svc.repos.setArchived("me/sched", false);
  }
});
