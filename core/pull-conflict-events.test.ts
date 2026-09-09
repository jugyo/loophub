import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";
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

function workflowMergeConflictEventsFor(
  repoId: number,
  number: number,
): number {
  return S.listEvents(0, repoId, 1000).filter(
    (e) =>
      e.type === "workflow_run.merge_conflict" &&
      (JSON.parse(e.payload) as { number?: number }).number === number,
  ).length;
}

function conflictSourcePayloadsFor(repoId: number, prNumber: number) {
  return S.listEvents(0, repoId, 1000)
    .filter((e) => e.type === "pull_request.merge_conflict")
    .map(
      (e) =>
        JSON.parse(e.payload) as {
          number: number;
          source_payload_version?: number;
          conflict_source?: "local" | "github" | "both";
        },
    )
    .filter((p) => p.number === prNumber);
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

test("targeted sweep は指定した base ref の open sibling だけを検査する", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const mainPull = S.createIssue(repo.id, "pull", "Main sibling", "", "me");
  S.createPull(mainPull.id, "main-sibling", "main", "main-head", null);
  const otherBasePull = S.createIssue(repo.id, "pull", "Other base", "", "me");
  S.createPull(
    otherBasePull.id,
    "other-sibling",
    "develop",
    "other-head",
    null,
  );
  const checked: number[] = [];
  const expectedMainPulls = S.openPulls().filter(
    (pull) => pull.repo_id === repo.id && pull.base_ref === "main",
  );

  const result = await D.sweepPullConflicts({
    repoId: repo.id,
    baseRef: "main",
    computeState: async (pull) => {
      checked.push(pull.number);
      return "clean";
    },
  });

  expect(result.checked).toBe(expectedMainPulls.length);
  expect(checked).toContain(mainPull.number);
  expect(checked).not.toContain(otherBasePull.number);
});

test("targeted sweep は実 git の base advance による sibling PR の conflict を検知する", async () => {
  const path = initGitRepo("lh-conflict-events-real-git-");
  const repo = await svc.repos.create({ path, name: "me/real-conflict" });
  git(path, ["checkout", "-qb", "sibling"]);
  writeFileSync(join(path, "a.txt"), "sibling\n");
  git(path, ["add", "-A"]);
  git(path, ["commit", "-qm", "sibling change"]);
  const headSha = git(path, ["rev-parse", "HEAD"]).stdout.trim();
  git(path, ["checkout", "-q", "main"]);

  const issue = S.createIssue(repo.id, "pull", "Real sibling", "", "me");
  S.createPull(issue.id, "sibling", "main", headSha, null);
  S.createReview(issue.id, "reviewer", "PASS", "looks good", headSha);
  const clean = await D.sweepPullConflicts({
    repoId: repo.id,
    baseRef: "main",
  });
  expect(clean.emitted).toBe(0);

  writeFileSync(join(path, "a.txt"), "base change\n");
  git(path, ["add", "-A"]);
  git(path, ["commit", "-qm", "base change"]);
  const conflict = await D.sweepPullConflicts({
    repoId: repo.id,
    baseRef: "main",
  });

  expect(conflict.emitted).toBe(1);
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
});

test("marks the conflict source so a Workflow run reacts to it directly", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(repo.id, "pull", "Workflow PR", "", "me");
  S.createPull(issue.id, "wf-feature", "main", "wfsha", null);
  const workflow = S.createWorkflow({
    name: "wf-conflict",
    description: "",
    executePrompt: "e",
    verifyPrompt: "v",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: issue.number,
    status: "running",
    currentStep: "verify",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "parent-session-1",
  });

  const stateByPr = new Map<number, MergeableState[]>();
  stateByPr.set(issue.number, ["clean", "conflict"]);
  const deps = {
    computeState: async (p: OpenPullSweepRow) =>
      stateByPr.get(p.number)?.shift() ?? "blocked",
  };

  await D.sweepPullConflicts(deps); // clean recorded
  await D.sweepPullConflicts(deps); // conflict: the source fires

  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
  const projected = S.listEvents(0, repo.id, 1000).filter(
    (e) => e.type === "workflow_run.merge_conflict",
  );
  expect(projected).toHaveLength(1);
  const sources = conflictSourcePayloadsFor(repo.id, issue.number);
  expect(sources).toHaveLength(1);
  expect(sources[0].source_payload_version).toBe(1);
  expect(sources[0].conflict_source).toBe("local");
  expect(JSON.parse(projected[0].payload)).toMatchObject({
    id: run.id,
    number: issue.number,
    parent_session_id: "parent-session-1",
    pr_number: issue.number,
    source_event_type: "pull_request.merge_conflict",
    conflict_source: "local",
  });
  expect(S.getWorkflowRun(run.id)?.status).toBe("running");
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

test("GitHub conflict is ORed with local state and does not re-fire", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(repo.id, "pull", "GitHub conflict PR", "", "me");
  S.createPull(issue.id, "github-conflict", "main", "github-sha", null);

  await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "clean",
  });
  S.saveGithubPullStatus(
    issue.id,
    JSON.stringify({ mergeable: "conflicting" }),
  );

  const conflict = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "clean",
  });
  const repeated = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "conflict",
  });

  expect(conflict).toEqual({ checked: 1, emitted: 1 });
  expect(repeated).toEqual({ checked: 1, emitted: 0 });
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
  expect(workflowMergeConflictEventsFor(repo.id, issue.number)).toBe(0);
  expect(conflictSourcePayloadsFor(repo.id, issue.number)[0]).toMatchObject({
    conflict_source: "github",
  });
});

test("GitHub conflict fires when the previous local state was blocked", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(repo.id, "pull", "Blocked GitHub PR", "", "me");
  S.createPull(issue.id, "blocked-github", "main", "blocked-sha", null);
  S.recordPullConflictState(repo.id, issue.number, "blocked");

  const result = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "blocked",
    githubStatus: {
      state: "open",
      merged: false,
      mergeable: "conflicting",
      reviewDecision: null,
      checks: "pending",
      comments: 0,
      reviews: 0,
      updatedAt: "2026-09-09T00:00:00Z",
      commitShas: [],
    },
  });

  expect(result).toEqual({ checked: 1, emitted: 1 });
  expect(conflictSourcePayloadsFor(repo.id, issue.number)[0]).toMatchObject({
    conflict_source: "github",
  });
});

test("a conflict observed locally and on GitHub records both sources", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(repo.id, "pull", "Dual conflict PR", "", "me");
  S.createPull(issue.id, "dual-conflict", "main", "dual-sha", null);
  S.recordPullConflictState(repo.id, issue.number, "clean");
  S.saveGithubPullStatus(
    issue.id,
    JSON.stringify({ mergeable: "conflicting" }),
  );

  const result = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "conflict",
  });

  expect(result).toEqual({ checked: 1, emitted: 1 });
  expect(conflictSourcePayloadsFor(repo.id, issue.number)[0]).toMatchObject({
    conflict_source: "both",
  });
});

test("the first GitHub conflict uses the same tick's local clean baseline", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(
    repo.id,
    "pull",
    "First GitHub conflict",
    "",
    "me",
  );
  S.createPull(issue.id, "first-github-conflict", "main", "first-sha", null);
  const githubStatus = {
    state: "open" as const,
    merged: false,
    mergeable: "conflicting" as const,
    reviewDecision: "approved" as const,
    checks: "success" as const,
    comments: 0,
    reviews: 1,
    updatedAt: "2026-09-09T00:00:00Z",
    commitShas: [],
  };

  const first = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "clean",
    githubStatus,
  });
  const repeated = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "clean",
    githubStatus,
  });

  expect(first).toEqual({ checked: 1, emitted: 1 });
  expect(repeated).toEqual({ checked: 1, emitted: 0 });
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
});

test("the first GitHub conflict is not lost when local state is unknown", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(
    repo.id,
    "pull",
    "Unknown local GitHub conflict",
    "",
    "me",
  );
  S.createPull(
    issue.id,
    "unknown-local-conflict",
    "main",
    "unknown-local",
    null,
  );
  const githubStatus = {
    state: "open" as const,
    merged: false,
    mergeable: "conflicting" as const,
    reviewDecision: "approved" as const,
    checks: "success" as const,
    comments: 0,
    reviews: 1,
    updatedAt: "2026-09-09T00:00:00Z",
    commitShas: [],
  };

  const first = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "unknown",
    githubStatus,
  });
  const recovered = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "clean",
    githubStatus,
  });

  expect(first).toEqual({ checked: 1, emitted: 1 });
  expect(recovered).toEqual({ checked: 1, emitted: 0 });
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
});

test("a local state failure does not discard a fresh GitHub conflict", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(
    repo.id,
    "pull",
    "Failed local GitHub conflict",
    "",
    "me",
  );
  S.createPull(issue.id, "failed-local-conflict", "main", "failed-local", null);
  const githubStatus = {
    state: "open" as const,
    merged: false,
    mergeable: "conflicting" as const,
    reviewDecision: "approved" as const,
    checks: "success" as const,
    comments: 0,
    reviews: 1,
    updatedAt: "2026-09-09T00:00:00Z",
    commitShas: [],
  };

  const result = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => {
      throw new Error("local git unavailable");
    },
    githubStatus,
  });

  expect(result).toEqual({ checked: 1, emitted: 1 });
  expect(JSON.parse(S.getGithubPullStatus(issue.id)!.payload)).toEqual(
    githubStatus,
  );
  expect(conflictSourcePayloadsFor(repo.id, issue.number)[0]).toMatchObject({
    conflict_source: "github",
  });
});

test("cached GitHub unknown leaves local conflict detection active", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(repo.id, "pull", "GitHub unknown PR", "", "me");
  S.createPull(issue.id, "github-unknown", "main", "unknown-sha", null);
  S.saveGithubPullStatus(issue.id, JSON.stringify({ mergeable: "unknown" }));
  const states: MergeableState[] = ["clean", "conflict"];

  await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => states.shift() ?? "unknown",
  });
  const result = await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => states.shift() ?? "unknown",
  });

  expect(result).toEqual({ checked: 1, emitted: 1 });
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
});

test("a stale local sweep cannot overwrite a concurrent GitHub conflict", async () => {
  const repo = S.getRepo("me", "conflict")!;
  const issue = S.createIssue(
    repo.id,
    "pull",
    "Concurrent conflict PR",
    "",
    "me",
  );
  S.createPull(issue.id, "concurrent-conflict", "main", "concurrent-sha", null);
  S.recordPullConflictState(repo.id, issue.number, "clean");
  S.saveGithubPullStatus(issue.id, JSON.stringify({ mergeable: "mergeable" }));
  let releaseLocal!: () => void;
  const localReady = Promise.withResolvers<void>();
  const localRelease = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const staleLocalSweep = D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => {
      localReady.resolve();
      await localRelease;
      return "clean";
    },
  });
  await localReady.promise;
  const githubStatus = {
    state: "open" as const,
    merged: false,
    mergeable: "conflicting" as const,
    reviewDecision: "approved" as const,
    checks: "success" as const,
    comments: 0,
    reviews: 1,
    updatedAt: "2026-09-09T00:00:00Z",
    commitShas: [],
  };

  await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "clean",
    githubStatus,
  });
  releaseLocal();
  await staleLocalSweep;
  await D.sweepPullConflicts({
    issueId: issue.id,
    computeState: async () => "clean",
    githubStatus,
  });

  expect(S.getPullConflictState(repo.id, issue.number)).toBe("conflict");
  expect(mergeConflictEventsFor(repo.id, issue.number)).toBe(1);
});
