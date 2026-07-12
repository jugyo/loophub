import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { MergeableState } from "./mergeable.ts";
import type { OpenPullSweepRow } from "./store/pulls.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-conflict-events-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let D: typeof import("./pull-conflict-events.ts");
let S: typeof import("./store.ts");
let svc: typeof import("./service.ts");
const repoDirs: string[] = [];
let repoPath: string;

function git(dir: string, args: string[]) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function initGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  repoDirs.push(dir);
  const g = (args: string[]) => git(dir, args);
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(dir, "a.txt"), "x\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return dir;
}

beforeAll(async () => {
  D = await import("./pull-conflict-events.ts");
  S = await import("./store.ts");
  svc = await import("./service.ts");
  repoPath = initGitRepo("lh-conflict-events-repo-");
  await svc.repos.create({ path: repoPath, name: "me/conflict" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true });
});

function mergeConflictEventsFor(repoId: number, number: number): number {
  return S.listEvents(0, repoId, 1000).filter(
    (e) =>
      e.type === "pull_request.merge_conflict" &&
      (JSON.parse(e.payload) as { number?: number }).number === number,
  ).length;
}

test("classifyConflictTransition only fires on the clean -> conflict edge", () => {
  const states: MergeableState[] = [
    "clean",
    "conflict",
    "no_commits",
    "blocked",
    "unknown",
  ];
  expect(D.classifyConflictTransition("clean", "conflict")).toBe(true);
  // Same conflict state (no re-fire) and every non-clean previous state must not fire.
  expect(D.classifyConflictTransition("conflict", "conflict")).toBe(false);
  expect(D.classifyConflictTransition("blocked", "conflict")).toBe(false);
  expect(D.classifyConflictTransition("no_commits", "conflict")).toBe(false);
  expect(D.classifyConflictTransition("unknown", "conflict")).toBe(false);
  expect(D.classifyConflictTransition(null, "conflict")).toBe(false);
  // clean -> anything-but-conflict never fires.
  for (const s of states) {
    if (s !== "conflict")
      expect(D.classifyConflictTransition("clean", s)).toBe(false);
  }
});

test("recordPullConflictState reports previous vs current and stays idempotent", () => {
  const repo = S.getRepo("me", "conflict")!;
  // First observation: no previous state.
  expect(S.recordPullConflictState(repo.id, 9001, "clean")).toEqual({
    previous: null,
    current: "clean",
  });
  // The stored clean is now the previous; a conflict is the detectable transition.
  expect(S.recordPullConflictState(repo.id, 9001, "conflict")).toEqual({
    previous: "clean",
    current: "conflict",
  });
  // Staying conflicted keeps previous === conflict, so classify won't re-fire.
  expect(S.recordPullConflictState(repo.id, 9001, "conflict")).toEqual({
    previous: "conflict",
    current: "conflict",
  });
});

test("sweep emits once per clean -> conflict transition and does not repeat", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(repo.id, "pull", "Reviewed PR", "", "me");
  S.createPull(issue.id, "feature", "main", "headsha", null);

  const queue: MergeableState[] = [];
  const deps = { computeState: async () => queue.shift() ?? "unknown" };

  // Tick 1: clean — no transition yet.
  queue.push("clean");
  let result = await D.sweepPullConflicts(deps);
  expect(result.emitted).toBe(0);
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(0);

  // Tick 2: conflict — the clean -> conflict edge fires the event once.
  queue.push("conflict");
  result = await D.sweepPullConflicts(deps);
  expect(result.emitted).toBe(1);
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);

  // Tick 3: still conflict — no second event.
  queue.push("conflict");
  result = await D.sweepPullConflicts(deps);
  expect(result.emitted).toBe(0);
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
});

test("a transient unknown tick does not consume the clean -> conflict edge", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(repo.id, "pull", "Flaky-state PR", "", "me");
  S.createPull(issue.id, "flaky-feature", "main", "flakysha", null);

  // Key states by PR so the earlier test's still-open PR gets a stable non-transition state and
  // only this PR walks clean -> unknown -> conflict.
  const stateByPr = new Map<number, MergeableState[]>();
  stateByPr.set(issue.number, ["clean", "unknown", "conflict"]);
  const deps = {
    computeState: async (p: OpenPullSweepRow) =>
      stateByPr.get(p.number)?.shift() ?? "blocked",
  };

  await D.sweepPullConflicts(deps); // clean recorded
  await D.sweepPullConflicts(deps); // unknown: computation failed this tick — must not overwrite clean
  const result = await D.sweepPullConflicts(deps); // conflict: the edge still fires

  expect(result.emitted).toBe(1);
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
});
