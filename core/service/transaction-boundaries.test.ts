import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Failure injection for the command transaction boundary: every DB-mutating service procedure must
// commit its state, comments, links, cursors and events together, or commit none of them.
//
// The failure is injected at the DB itself rather than by mocking a store helper, so the real code
// path runs: a BEFORE INSERT trigger aborts one event write, which is the last statement of most
// commands. SQLite's RAISE(ABORT) reverts only the offending statement and leaves the transaction
// open, so what the assertions observe afterwards is exactly what the command's own rollback left.

const HOME = mkdtempSync(join(tmpdir(), "lh-tx-boundaries-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

const REPO = "me/tx-boundaries";
const PARENT_SESSION = "11111111-1111-4111-8111-111111111111";
const HUMAN_SESSION = "33333333-3333-4333-8333-333333333333";

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let database: typeof import("../db.ts")["db"];
let repoPath: string;
let repoId: number;
let prNumber: number;
let baseSha: string;
let headSha: string;

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

// Make the next insert of `type` fail. The trigger is created and dropped in autocommit mode, so a
// rolled-back command cannot take it with it. SQLite rejects bound parameters inside a trigger
// body, so the type is inlined — every caller passes an internal event-type constant.
function failingEvent(type: string): { drop: () => void } {
  database.run(
    `CREATE TRIGGER inject_event_failure BEFORE INSERT ON events
     WHEN NEW.type = '${type}'
     BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`,
  );
  return { drop: () => database.run("DROP TRIGGER inject_event_failure") };
}

function whileFailing<T>(type: string, run: () => T): T {
  const injected = failingEvent(type);
  try {
    return run();
  } finally {
    injected.drop();
  }
}

function failingInsert(table: "pulls"): { drop: () => void } {
  database.run(
    `CREATE TRIGGER inject_${table}_failure BEFORE INSERT ON ${table}
     BEGIN SELECT RAISE(ABORT, 'injected ${table} failure'); END`,
  );
  return {
    drop: () => database.run(`DROP TRIGGER inject_${table}_failure`),
  };
}

async function whileFailingInsert<T>(
  table: "pulls",
  run: () => Promise<T>,
): Promise<T> {
  const injected = failingInsert(table);
  try {
    return await run();
  } finally {
    injected.drop();
  }
}

async function whileFailingAsync<T>(
  type: string,
  run: () => Promise<T>,
): Promise<T> {
  const injected = failingEvent(type);
  try {
    return await run();
  } finally {
    injected.drop();
  }
}

function eventTypes(): string[] {
  return S.listEvents(0, repoId, 500).map((row) => row.type);
}

function pullCreationCounts(): {
  issues: number;
  pulls: number;
  openedEvents: number;
} {
  const count = (sql: string): number =>
    (database.query(sql).get(repoId) as { count: number }).count;
  return {
    issues: count(
      "SELECT COUNT(*) AS count FROM issues WHERE repo_id = ? AND kind = 'pull'",
    ),
    pulls: count(
      `SELECT COUNT(*) AS count FROM pulls p
       JOIN issues i ON i.id = p.issue_id WHERE i.repo_id = ?`,
    ),
    openedEvents: count(
      "SELECT COUNT(*) AS count FROM events WHERE repo_id = ? AND type = 'pull_request.opened'",
    ),
  };
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  ({ db: database } = await import("../db.ts"));

  repoPath = mkdtempSync(join(tmpdir(), "lh-tx-boundaries-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  baseSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "-qb", "feature"]);
  writeFileSync(join(repoPath, "a.txt"), "one\nchanged\nthree\nfour\nfive\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature"]);
  headSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: REPO });
  repoId = (await svc.repos.get(REPO)).id;
  S.registerAgentSession(HUMAN_SESSION, "me", "human-runtime");
  S.registerAgentSession(PARENT_SESSION, "lh-workflow", "parent-runtime");

  prNumber = (
    await svc.pulls.create(REPO, {
      title: "boundary target",
      body: "",
      head: "feature",
      base: "main",
    })
  ).number;
}, 30_000);

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("a failed issue.opened event leaves no issue, labels or criteria behind", () => {
  const before = S.listIssues(repoId, "issue", "open", "created").length;

  expect(() =>
    whileFailing("issue.opened", () =>
      svc.issues.create(REPO, {
        title: "half-created",
        body: "body",
        labels: ["bug"],
        acceptance_criteria: ["It works."],
      }),
    ),
  ).toThrowError(/injected event failure/);

  const issues = S.listIssues(repoId, "issue", "open", "created");
  expect(issues).toHaveLength(before);
  expect(issues.some((row) => row.title === "half-created")).toBe(false);
  // The labels and criteria of the abandoned issue are gone with it.
  expect(S.listLabels(repoId).some((label) => label.name === "bug")).toBe(
    false,
  );
});

test("a failed sub-issue update event rolls back attach and detach", () => {
  const parent = svc.issues.create(REPO, { title: "sub-issue parent" });
  const child = svc.issues.create(REPO, { title: "sub-issue child" });

  expect(() =>
    whileFailing("issue.updated", () =>
      svc.issues.attachSubIssue(REPO, parent.number, child.number),
    ),
  ).toThrowError(/injected event failure/);
  expect(S.getIssue(repoId, child.number)!.parent_issue_id).toBeNull();

  svc.issues.attachSubIssue(REPO, parent.number, child.number);
  expect(() =>
    whileFailing("issue.updated", () =>
      svc.issues.detachSubIssue(REPO, child.number),
    ),
  ).toThrowError(/injected event failure/);
  expect(S.getIssue(repoId, child.number)!.parent_issue_id).toBe(
    S.getIssue(repoId, parent.number)!.id,
  );
});

test("a failed pull ref observation leaves no pull-shaped issue", async () => {
  const before = pullCreationCounts();
  let observedHead = "";

  await expect(
    svc.pulls.create(
      REPO,
      {
        title: "failed pull ref observation",
        headFromNumber: (number) => `loophub/pr-${number}`,
        base: "main",
      },
      null,
      {
        revParse: async (_path, ref) => {
          expect(database.inTransaction).toBe(false);
          // Refs reach git qualified as refs/heads/<name> (#12).
          if (ref.startsWith("refs/heads/loophub/pr-")) {
            observedHead = ref;
            throw new Error("injected ref observation failure");
          }
          return baseSha;
        },
      },
    ),
  ).rejects.toThrowError(/injected ref observation failure/);

  expect(observedHead).toMatch(/^refs\/heads\/loophub\/pr-\d+$/);
  expect(pullCreationCounts()).toEqual(before);
});

test("a failed pull insert leaves no pull-shaped issue", async () => {
  const before = pullCreationCounts();

  await expect(
    whileFailingInsert("pulls", () =>
      svc.pulls.create(REPO, {
        title: "failed pull insert",
        head: "feature",
        base: "main",
      }),
    ),
  ).rejects.toThrowError(/injected pulls failure/);

  expect(pullCreationCounts()).toEqual(before);
});

test("a failed pull_request.opened event leaves no pull or pull-shaped issue", async () => {
  const before = pullCreationCounts();

  await expect(
    whileFailingAsync("pull_request.opened", () =>
      svc.pulls.create(REPO, {
        title: "failed pull opened event",
        head: "feature",
        base: "main",
      }),
    ),
  ).rejects.toThrowError(/injected event failure/);

  expect(pullCreationCounts()).toEqual(before);
});

test("a failed linked-PR close leaves the issue open and writes no system comment", () => {
  const created = svc.issues.create(REPO, {
    title: "cascade source",
    body: "",
  });
  const issue = S.getIssue(repoId, created.number)!;
  const pull = S.createIssue(repoId, "pull", "cascade target", "", "me");
  S.createPull(pull.id, "feature", "main", headSha, issue.id, null, baseSha);

  expect(() =>
    whileFailing("pull_request.closed", () =>
      svc.issues.update(REPO, issue.number, { state: "closed" }),
    ),
  ).toThrowError(/injected event failure/);

  // State, cascade and both events roll back together: the issue is still open, its linked PR is
  // still open, and the "closed because…" comment was never left behind.
  expect(S.getIssue(repoId, issue.number)!.state).toBe("open");
  expect(S.getIssueById(pull.id)!.state).toBe("open");
  expect(S.listComments(pull.id)).toHaveLength(0);
  expect(eventTypes()).not.toContain("issue.closed");
});

test("a failed pull_request.commented event leaves no comment", () => {
  const pr = S.getIssue(repoId, prNumber)!;
  const before = S.listComments(pr.id).length;

  expect(() =>
    whileFailing("pull_request.commented", () =>
      svc.comments.createForPull(REPO, prNumber, "orphan", HUMAN_SESSION),
    ),
  ).toThrowError(/injected event failure/);

  expect(S.listComments(pr.id)).toHaveLength(before);
});

test("a failed comment reaction event leaves the existing reaction unchanged", () => {
  const comment = svc.comments.createHumanForPull(
    REPO,
    prNumber,
    "Keep the existing reaction",
  );
  svc.comments.reactForPull(REPO, prNumber, comment.id, "👀", HUMAN_SESSION);

  expect(() =>
    whileFailing("pull_request.comment_reaction_changed", () =>
      svc.comments.reactForPull(
        REPO,
        prNumber,
        comment.id,
        "🚀",
        HUMAN_SESSION,
      ),
    ),
  ).toThrowError(/injected event failure/);

  expect(S.listCommentReactions(comment.id)).toMatchObject([{ emoji: "👀" }]);
});

test("a failed review_submitted event leaves no review or line comments", async () => {
  const pr = S.getIssue(repoId, prNumber)!;

  await expect(
    whileFailingAsync("pull_request.review_submitted", () =>
      svc.reviews.create(
        REPO,
        prNumber,
        {
          event: "REQUEST_CHANGES",
          body: "needs work",
          comments: [{ path: "a.txt", line: 2, side: "RIGHT", body: "here" }],
        },
        HUMAN_SESSION,
      ),
    ),
  ).rejects.toThrowError(/injected event failure/);

  expect(S.listReviews(pr.id)).toHaveLength(0);
  expect(S.listReviewComments(pr.id)).toHaveLength(0);
});

test("a failed diff_feedback_created event leaves no thread or message", async () => {
  const pr = S.getIssue(repoId, prNumber)!;

  await expect(
    whileFailingAsync("pull_request.diff_feedback_created", () =>
      svc.diffFeedback.create(
        REPO,
        prNumber,
        {
          baseSha,
          headSha,
          path: "a.txt",
          side: "RIGHT",
          startLine: 2,
          endLine: 2,
          body: "orphan thread",
        },
        HUMAN_SESSION,
      ),
    ),
  ).rejects.toThrowError(/injected event failure/);

  expect(S.listDiffFeedbackThreads(pr.id)).toHaveLength(0);
});

test("a failed workflow_run.updated event leaves the run lifecycle unchanged", () => {
  const workflow = S.createWorkflow({
    name: "tx-boundary-workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId,
    issueNumber: prNumber,
    prNumber,
    status: "running",
    currentStep: "execute",
    parentSessionId: PARENT_SESSION,
    costIncrementUsd: 10,
    costLimitUsd: 10,
  });

  expect(() =>
    whileFailing("workflow_run.updated", () =>
      svc.workflowRuns.awaitHuman(
        REPO,
        { run: run.id, reason: "needs a decision" },
        PARENT_SESSION,
      ),
    ),
  ).toThrowError(/injected event failure/);

  // A hold the parent can never be told about must not exist on the run row either.
  expect(S.getWorkflowRun(run.id)!.needs_human_reason).toBeNull();
});

test("a failed notification.created event leaves no notification", () => {
  const before = S.listNotifications({}).length;

  expect(() =>
    whileFailing("notification.created", () =>
      svc.notifications.send(REPO, {
        kind: "human_attention",
        title: "Attention",
        body: "Something needs a human.",
        resourceKind: "repo",
        sourceKey: "tx-boundary",
      }),
    ),
  ).toThrowError(/injected event failure/);

  expect(S.listNotifications({})).toHaveLength(before);
});

test("a failed agent_session.linked event leaves no session link", () => {
  const sessionId = "44444444-4444-4444-8444-444444444444";
  S.registerAgentSession(sessionId, "codex", "link-runtime");

  expect(() =>
    whileFailing("agent_session.linked", () =>
      svc.sessions.link(REPO, { sessionId, pr: prNumber }),
    ),
  ).toThrowError(/injected event failure/);

  expect(S.listSessionLinkedTargets(sessionId)).toHaveLength(0);
});

test("a failed worker sweep event leaves the observed head SHA unrecorded", async () => {
  // Move the head so the sweep has an update to publish, then fail the event it publishes.
  git(["checkout", "-q", "feature"]);
  writeFileSync(join(repoPath, "a.txt"), "one\nchanged again\nthree\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "second"]);
  const movedSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);

  const pull = S.getPull(S.getIssue(repoId, prNumber)!.id)!;
  expect(pull.head_sha).not.toBe(movedSha);

  await expect(
    whileFailingAsync("pull_request.updated", () => svc.sync.run()),
  ).rejects.toThrowError(/injected event failure/);

  // A recorded SHA without its event would silence the update forever: the next sweep would see no
  // change and never publish it.
  expect(S.getPull(S.getIssue(repoId, prNumber)!.id)!.head_sha).toBe(
    pull.head_sha,
  );
});

test("a failed generated notification leaves its source cursor unadvanced", async () => {
  // Settle whatever the merge-ready sweep would generate on its own first, so the only
  // notification.created insert under injection below is the one the signal backfill makes.
  await svc.notifications.sweep();
  const cursorBefore = S.notificationSourceCursors().events;

  const signal = svc.events.emit(repoId, "dev.cost_stopped", "lh-worker", {
    number: prNumber,
  });
  const sourceKey = `cost:${repoId}:${prNumber}:${signal.id}`;
  const hasSignalNotification = () =>
    S.listNotifications({}).some((row) => row.source_key === sourceKey);

  await expect(
    whileFailingAsync("notification.created", () => svc.notifications.sweep()),
  ).rejects.toThrowError(/injected event failure/);

  // The cursor says "every signal up to here has been turned into a notification". Advancing it
  // without the notification would drop this signal permanently, so it must roll back too.
  expect(S.notificationSourceCursors().events).toBe(cursorBefore);
  expect(hasSignalNotification()).toBe(false);

  // The retained cursor is what lets the next sweep still reach the signal.
  await svc.notifications.sweep();
  expect(hasSignalNotification()).toBe(true);
});

// The remaining worker sweeps consume an edge — a state transition, a link's "not merged yet" flag,
// a snapshot signature — when they record it. Recording without the event the edge produced would
// leave every later tick seeing no change, so the event can never be published again.

test("a failed merge-conflict event leaves the clean -> conflict edge unconsumed", async () => {
  const { sweepPullConflicts } = await import("../pull-conflict-events.ts");
  const conflictEvents = () =>
    eventTypes().filter((type) => type === "pull_request.merge_conflict")
      .length;

  await sweepPullConflicts({ computeState: async () => "clean" });
  const before = conflictEvents();

  await expect(
    whileFailingAsync("pull_request.merge_conflict", () =>
      sweepPullConflicts({ computeState: async () => "conflict" }),
    ),
  ).rejects.toThrowError(/injected event failure/);

  expect(conflictEvents()).toBe(before);
  // Every open PR was recorded `clean` above and is now `conflict`, so a complete retry reports one
  // conflict per PR. A PR whose stored state advanced without its event reads conflict -> conflict
  // instead, and is silently missing from this count.
  const retried = await sweepPullConflicts({
    computeState: async () => "conflict",
  });
  expect(retried.checked).toBeGreaterThan(0);
  expect(retried.emitted).toBe(retried.checked);
});

test("a failed github_merged event leaves the link still worth polling", async () => {
  const { syncGithubMergeStatus } = await import("../github-merge-sync.ts");
  svc.pulls.recordGithubPull(REPO, prNumber, {
    github_number: 4242,
    url: "https://github.com/me/tx-boundaries/pull/4242",
  });
  const deps = {
    async fetchMergeStatus() {
      return {
        merged: true,
        mergedAt: "2026-01-01T00:00:00Z",
        mergedByLogin: "someone",
      };
    },
  };
  const isPollable = () =>
    S.unmergedGithubPullLinks().some((link) => link.number === prNumber);
  expect(isPollable()).toBe(true);

  await expect(
    whileFailingAsync("pull_request.github_merged", () =>
      syncGithubMergeStatus(deps),
    ),
  ).rejects.toThrowError(/injected event failure/);

  // Recording the merge alone drops the link out of the sweep, so the prompt would never appear.
  expect(isPollable()).toBe(true);
  expect(await syncGithubMergeStatus(deps)).toHaveLength(1);
  expect(isPollable()).toBe(false);
});

test("a failed terminal snapshot event leaves the stored signature unchanged", async () => {
  const { snapshotHerdrSessionsImpl } = await import(
    "../terminal/herdr-cleanup.ts"
  );
  await snapshotHerdrSessionsImpl({ sweep: async () => ({ repos: [] }) });
  const changed = { repos: [], running_repos: [REPO] };

  await expect(
    whileFailingAsync("terminal.sessions_updated", () =>
      snapshotHerdrSessionsImpl({ sweep: async () => changed }),
    ),
  ).rejects.toThrowError(/injected event failure/);

  // A stored signature with no event leaves clients on the previous snapshot until some unrelated
  // change happens to move the signature again.
  const retried = await snapshotHerdrSessionsImpl({
    sweep: async () => changed,
  });
  expect(retried.changed).toBe(true);
});
