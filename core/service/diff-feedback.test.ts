import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { traceGitCommands } from "../git-trace-test-helper.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-diff-feedback-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

const REPO = "me/diff-feedback";
const PARENT_SESSION = "11111111-1111-4111-8111-111111111111";
const EXECUTE_SESSION = "22222222-2222-4222-8222-222222222222";
const HUMAN_SESSION = "33333333-3333-4333-8333-333333333333";

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let database: typeof import("../db.ts")["db"];
let repoPath: string;
let repoId: number;
let prNumber: number;
let baseSha: string;
let headSha: string;
let runId: number;

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function createThread(body: string, sessionId: string = HUMAN_SESSION) {
  return svc.diffFeedback.create(
    REPO,
    prNumber,
    {
      baseSha,
      headSha,
      path: "a.txt",
      side: "RIGHT",
      startLine: 2,
      endLine: 2,
      body,
    },
    sessionId,
  );
}

function runEvents() {
  return S.eventsForWorkflowRun(repoId, runId).filter(
    (event) => event.type === "workflow_run.diff_feedback",
  );
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  ({ db: database } = await import("../db.ts"));
  repoPath = mkdtempSync(join(tmpdir(), "lh-diff-feedback-repo-"));
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
  const pull = await svc.pulls.create(REPO, {
    title: "feedback target",
    body: "",
    head: "feature",
    base: "main",
  });
  prNumber = pull.number;

  S.registerAgentSession(HUMAN_SESSION, "me", "human-runtime");
  S.registerAgentSession(
    EXECUTE_SESSION,
    "claude-code",
    "execute-runtime",
    "executor #1-1",
  );
  const workflow = S.createWorkflow({
    name: "diff-feedback-workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  runId = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId,
    issueNumber: prNumber,
    prNumber,
    status: "running",
    currentStep: "execute",
    parentSessionId: PARENT_SESSION,
    costIncrementUsd: 10,
    costLimitUsd: 10,
  }).id;
  S.appendWorkflowRunStepSession(runId, "execute", EXECUTE_SESSION);
}, 30_000);

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("a diff comment records its anchor on the domain event, not a copy of itself", async () => {
  const created = await createThread("Why is this changed?");
  const event = S.listEvents(0, repoId, 100).find(
    (row) => row.type === "pull_request.diff_feedback_created",
  );

  expect(event).toBeDefined();
  // The commenter is the event's own actor, and the body stays in the comment row the ids name.
  expect(event!.actor).toBe("me");
  expect(JSON.parse(event!.payload)).toEqual({
    number: prNumber,
    thread_id: created.thread.id,
    comment_id: created.comment.id,
    path: "a.txt",
    side: "RIGHT",
    start_line: 2,
    end_line: 2,
  });
});

test("the comment is projected onto the running workflow run for its PR", () => {
  const projected = runEvents();
  expect(projected).toHaveLength(1);
  expect(JSON.parse(projected[0].payload)).toMatchObject({
    id: runId,
    pr_number: prNumber,
    parent_session_id: PARENT_SESSION,
    source_event_type: "pull_request.diff_feedback_created",
  });
});

test("Execute reads the unanswered comment with the diff around its anchor", async () => {
  const pending = await svc.diffFeedback.pending(REPO, prNumber, runId);

  expect(pending.run).toBe(runId);
  expect(pending.threads).toHaveLength(1);
  expect(pending.threads[0]).toMatchObject({
    freshness: "current",
    anchor: { path: "a.txt", side: "RIGHT", start_line: 2, end_line: 2 },
  });
  expect(pending.threads[0].context).toContainEqual(
    expect.objectContaining({ text: "+changed", anchored: true }),
  );
  expect(pending.threads[0].context).toContainEqual(
    expect.objectContaining({ text: " three", anchored: false }),
  );
});

test("an Execute reply answers the comment without waking its own parent", async () => {
  const before = runEvents().length;
  const thread = (await svc.diffFeedback.list(REPO, prNumber)).threads[0];

  const replied = await svc.diffFeedback.reply(
    REPO,
    prNumber,
    thread.id,
    "Renamed for clarity.",
    EXECUTE_SESSION,
  );

  expect(replied.reply).toMatchObject({
    author: "executor #1-1",
    body: "Renamed for clarity.",
  });
  expect(runEvents()).toHaveLength(before);
  const pending = await traceGitCommands(() =>
    svc.diffFeedback.pending(REPO, prNumber, runId),
  );
  expect(pending.result.threads).toEqual([]);
  expect(
    pending.commands.filter((command) => command.startsWith("diff ")),
  ).toEqual([]);
});

test("a supported reaction can be added, changed, and removed once per actor", async () => {
  const thread = (await svc.diffFeedback.list(REPO, prNumber)).threads[0];
  const message = thread.messages[0];

  const added = await svc.diffFeedback.react(
    REPO,
    prNumber,
    message.id,
    "👍",
    HUMAN_SESSION,
  );
  expect(added.reactions).toEqual([{ emoji: "👍", count: 1, reacted: true }]);

  const changed = await svc.diffFeedback.react(
    REPO,
    prNumber,
    message.id,
    "🎉",
    HUMAN_SESSION,
  );
  expect(changed.reactions).toEqual([{ emoji: "🎉", count: 1, reacted: true }]);

  const removed = await svc.diffFeedback.react(
    REPO,
    prNumber,
    message.id,
    "🎉",
    HUMAN_SESSION,
  );
  expect(removed.reactions).toEqual([]);

  await svc.diffFeedback.react(REPO, prNumber, message.id, "👍", HUMAN_SESSION);
  await svc.diffFeedback.react(
    REPO,
    prNumber,
    message.id,
    "👍",
    EXECUTE_SESSION,
  );

  expect(
    (await svc.diffFeedback.list(REPO, prNumber, {}, HUMAN_SESSION)).threads[0]
      .messages[0].reactions,
  ).toEqual([{ emoji: "👍", count: 2, reacted: true }]);
  await expect(
    svc.diffFeedback.react(REPO, prNumber, message.id, "😈", HUMAN_SESSION),
  ).rejects.toThrow("unsupported diff feedback reaction");
});

test("a failed reaction change preserves the existing server reaction", async () => {
  const thread = (await svc.diffFeedback.list(REPO, prNumber)).threads[0];
  const message = thread.messages[0];
  database.exec(`
    CREATE TEMP TRIGGER fail_diff_feedback_reaction_update
    BEFORE UPDATE ON diff_feedback_reactions
    BEGIN
      SELECT RAISE(ABORT, 'forced reaction update failure');
    END
  `);
  try {
    await expect(
      svc.diffFeedback.react(REPO, prNumber, message.id, "🎉", HUMAN_SESSION),
    ).rejects.toThrow("forced reaction update failure");
  } finally {
    database.exec("DROP TRIGGER fail_diff_feedback_reaction_update");
  }

  expect(
    (await svc.diffFeedback.list(REPO, prNumber, {}, HUMAN_SESSION)).threads[0]
      .messages[0].reactions,
  ).toEqual([{ emoji: "👍", count: 2, reacted: true }]);
});

test("a follow-up comment from outside the run becomes pending again", async () => {
  const thread = (await svc.diffFeedback.list(REPO, prNumber)).threads[0];
  const before = runEvents().length;

  await svc.diffFeedback.reply(
    REPO,
    prNumber,
    thread.id,
    "Still unclear.",
    HUMAN_SESSION,
  );

  expect(runEvents()).toHaveLength(before + 1);
  expect(
    (await svc.diffFeedback.pending(REPO, prNumber, runId)).threads.map(
      ({ id }) => id,
    ),
  ).toEqual([thread.id]);
});

test("a PR with no running workflow run only records the domain event", async () => {
  S.updateWorkflowRun(runId, { status: "completed" });
  const before = S.listEvents(0, repoId, 500).length;

  const created = await createThread("Late thought.");

  const events = S.listEvents(0, repoId, 500);
  expect(events).toHaveLength(before + 1);
  expect(events.at(-1)).toMatchObject({
    type: "pull_request.diff_feedback_created",
  });
  expect(created.comment.body).toBe("Late thought.");
});

test("list and get resolve a shifted anchor without changing its original coordinates", async () => {
  git(["checkout", "-q", "feature"]);
  writeFileSync(
    join(repoPath, "a.txt"),
    "zero\none\nchanged\nthree\nfour\nfive\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "insert above feedback"]);
  git(["checkout", "-q", "main"]);

  const fallback = await svc.diffFeedback.list(REPO, prNumber);
  expect(fallback.threads[0]).toMatchObject({
    freshness: "unavailable",
    placement: "inline",
    anchor: { start_line: 2, end_line: 2 },
    resolved_anchor: null,
    original_context: null,
  });

  expect(await svc.diffFeedback.precompute(REPO, prNumber)).toBeGreaterThan(0);
  const cachedPrecompute = await traceGitCommands(() =>
    svc.diffFeedback.precompute(REPO, prNumber),
  );
  expect(cachedPrecompute.result).toBe(0);
  expect(
    cachedPrecompute.commands.filter((command) => command.startsWith("diff ")),
  ).toEqual([]);
  const listed = await svc.diffFeedback.list(REPO, prNumber);
  expect(listed.threads[0]).toMatchObject({
    freshness: "current",
    placement: "inline",
    anchor: { start_line: 2, end_line: 2 },
    resolved_anchor: { start_line: 3, end_line: 3 },
  });
  const cachedPending = await traceGitCommands(() =>
    svc.diffFeedback.pending(REPO, prNumber, runId),
  );
  expect(cachedPending.result.threads[0]).toMatchObject({
    resolved_anchor: { start_line: 3, end_line: 3 },
  });
  expect(
    cachedPending.result.threads[0].context?.some(
      (line) => line.text === "+changed" && line.anchored,
    ),
  ).toBe(true);
  expect(
    cachedPending.commands.filter((command) => command.startsWith("show ")),
  ).toEqual([]);

  const detail = await svc.diffFeedback.get(
    REPO,
    prNumber,
    listed.threads[0].id,
  );
  expect(detail.context).toContainEqual(
    expect.objectContaining({
      text: "+changed",
      right_line: 3,
      anchored: true,
    }),
  );
  expect(detail.original_context).toContainEqual(
    expect.objectContaining({
      text: "+changed",
      right_line: 2,
      anchored: true,
    }),
  );

  const location = S.listDiffFeedbackLocations(
    S.getIssue(repoId, prNumber)!.id,
    git(["merge-base", "main", "feature"]),
    git(["rev-parse", "feature"]),
  )[0];
  const invalidValues: Array<[string, string | null]> = [
    ["freshness", "stale"],
    ["placement", "floating"],
    ["outdated_reason", "unknown"],
    ["resolved_anchor_json", "{}"],
    ["original_context_json", "[{}]"],
  ];
  for (const [column, invalidValue] of invalidValues) {
    const originalValue = location[column as keyof typeof location];
    database
      .query(
        `UPDATE diff_feedback_locations SET ${column} = ? WHERE thread_id = ? AND base_sha = ? AND head_sha = ?`,
      )
      .run(
        invalidValue,
        location.thread_id,
        location.base_sha,
        location.head_sha,
      );
    await expect(svc.diffFeedback.list(REPO, prNumber)).rejects.toThrow(
      `invalid diff feedback location for thread ${location.thread_id}`,
    );
    database
      .query(
        `UPDATE diff_feedback_locations SET ${column} = ? WHERE thread_id = ? AND base_sha = ? AND head_sha = ?`,
      )
      .run(
        originalValue,
        location.thread_id,
        location.base_sha,
        location.head_sha,
      );
  }
});

test("an outdated conversation remains replyable, reactable, and resolvable", async () => {
  git(["checkout", "-q", "feature"]);
  writeFileSync(join(repoPath, "a.txt"), "zero\none\nthree\nfour\nfive\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "remove feedback target"]);
  git(["checkout", "-q", "main"]);

  await svc.diffFeedback.precompute(REPO, prNumber);
  const thread = (await svc.diffFeedback.list(REPO, prNumber)).threads[0];
  expect(thread).toMatchObject({
    freshness: "outdated",
    outdated_reason: "deleted",
    anchor: { start_line: 2, end_line: 2 },
    resolved_anchor: null,
  });

  const resolved = await svc.diffFeedback.resolve(
    REPO,
    prNumber,
    thread.id,
    true,
    HUMAN_SESSION,
  );
  expect(resolved).toMatchObject({
    freshness: "outdated",
    resolved: true,
    resolved_by: "me",
  });
  await svc.diffFeedback.reply(
    REPO,
    prNumber,
    thread.id,
    "Resolved after removal.",
    HUMAN_SESSION,
  );
  await svc.diffFeedback.react(
    REPO,
    prNumber,
    thread.messages[0].id,
    "🎉",
    HUMAN_SESSION,
  );
  expect(
    (await svc.diffFeedback.pending(REPO, prNumber, runId)).threads.map(
      ({ id }) => id,
    ),
  ).not.toContain(thread.id);

  const reopened = await svc.diffFeedback.resolve(
    REPO,
    prNumber,
    thread.id,
    false,
    HUMAN_SESSION,
  );
  expect(reopened).toMatchObject({
    freshness: "outdated",
    resolved: false,
    resolved_by: null,
    resolved_at: null,
  });
});

test("service responses expose move, fuzzy, ambiguous, and unavailable resolution", async () => {
  git(["checkout", "-q", "feature"]);
  writeFileSync(join(repoPath, "move.txt"), "one\nmove target\nthree\nfour\n");
  writeFileSync(
    join(repoPath, "fuzzy.txt"),
    "before\nconst answer = 41;\nafter\n",
  );
  writeFileSync(join(repoPath, "ambiguous.txt"), "a\nb\nc\ntarget\nd\ne\nf\n");
  writeFileSync(join(repoPath, "lcs-ambiguous.txt"), "before\ntarget\nafter\n");
  writeFileSync(
    join(repoPath, "lcs-tied-prediction.txt"),
    "a\ntarget\nb\nc\nd\n",
  );
  writeFileSync(
    join(repoPath, "unavailable.txt"),
    "before\nbinary target\nafter\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "add resolution cases"]);
  const originalHead = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);

  const createCase = (path: string, line: number, body: string) =>
    svc.diffFeedback.create(
      REPO,
      prNumber,
      {
        baseSha,
        headSha: originalHead,
        path,
        side: "RIGHT",
        startLine: line,
        endLine: line,
        body,
      },
      HUMAN_SESSION,
    );
  const [
    moved,
    fuzzy,
    ambiguous,
    lcsAmbiguous,
    lcsTiedPrediction,
    unavailable,
  ] = await Promise.all([
    createCase("move.txt", 2, "Moved target"),
    createCase("fuzzy.txt", 2, "Fuzzy target"),
    createCase("ambiguous.txt", 4, "Ambiguous target"),
    createCase("lcs-ambiguous.txt", 2, "LCS ambiguous target"),
    createCase("lcs-tied-prediction.txt", 2, "LCS tied prediction target"),
    createCase("unavailable.txt", 2, "Unavailable target"),
  ]);

  git(["checkout", "-q", "feature"]);
  writeFileSync(join(repoPath, "move.txt"), "one\nthree\nfour\nmove target\n");
  writeFileSync(
    join(repoPath, "fuzzy.txt"),
    "before\nconst answer = 42;\nafter\n",
  );
  writeFileSync(
    join(repoPath, "ambiguous.txt"),
    "target\na\nb\nc\nd\ne\nf\ntarget\n",
  );
  writeFileSync(
    join(repoPath, "lcs-ambiguous.txt"),
    "before\ntarget\ntarget\nafter\n",
  );
  writeFileSync(
    join(repoPath, "lcs-tied-prediction.txt"),
    "target\na\nb\nc\nd\ntarget\n",
  );
  writeFileSync(join(repoPath, "unavailable.txt"), "before\0after\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "update resolution cases"]);
  git(["checkout", "-q", "main"]);

  const movedDetail = await svc.diffFeedback.get(
    REPO,
    prNumber,
    moved.thread.id,
  );
  expect(movedDetail).toMatchObject({
    freshness: "current",
    placement: "inline",
    anchor: { start_line: 2, end_line: 2 },
    resolved_anchor: { start_line: 4, end_line: 4 },
  });
  expect(movedDetail.context).toContainEqual(
    expect.objectContaining({
      text: "+move target",
      right_line: 4,
      anchored: true,
    }),
  );

  const fuzzyDetail = await svc.diffFeedback.get(
    REPO,
    prNumber,
    fuzzy.thread.id,
  );
  expect(fuzzyDetail).toMatchObject({
    freshness: "current",
    placement: "inline",
    anchor: { start_line: 2, end_line: 2 },
    resolved_anchor: { start_line: 2, end_line: 2 },
  });
  expect(fuzzyDetail.context).toContainEqual(
    expect.objectContaining({
      text: "+const answer = 42;",
      right_line: 2,
      anchored: true,
    }),
  );

  const ambiguousDetail = await svc.diffFeedback.get(
    REPO,
    prNumber,
    ambiguous.thread.id,
  );
  expect(ambiguousDetail).toMatchObject({
    freshness: "outdated",
    outdated_reason: "ambiguous",
    placement: "inline",
    anchor: { start_line: 4, end_line: 4 },
    resolved_anchor: null,
  });
  expect(ambiguousDetail.context).toContainEqual(
    expect.objectContaining({
      text: "+target",
      right_line: 4,
      anchored: true,
    }),
  );

  const lcsAmbiguousDetail = await svc.diffFeedback.get(
    REPO,
    prNumber,
    lcsAmbiguous.thread.id,
  );
  expect(lcsAmbiguousDetail).toMatchObject({
    freshness: "outdated",
    outdated_reason: "ambiguous",
    placement: "inline",
    anchor: { start_line: 2, end_line: 2 },
    resolved_anchor: null,
  });
  expect(lcsAmbiguousDetail.context).toContainEqual(
    expect.objectContaining({
      text: "+target",
      right_line: 2,
      anchored: true,
    }),
  );

  const lcsTiedPredictionDetail = await svc.diffFeedback.get(
    REPO,
    prNumber,
    lcsTiedPrediction.thread.id,
  );
  expect(lcsTiedPredictionDetail).toMatchObject({
    freshness: "outdated",
    outdated_reason: "ambiguous",
    placement: "inline",
    anchor: { start_line: 2, end_line: 2 },
    resolved_anchor: null,
  });

  const unavailableDetail = await svc.diffFeedback.get(
    REPO,
    prNumber,
    unavailable.thread.id,
  );
  expect(unavailableDetail).toMatchObject({
    freshness: "unavailable",
    outdated_reason: null,
    placement: "historical",
    anchor: { start_line: 2, end_line: 2 },
    resolved_anchor: null,
  });
  expect(unavailableDetail.context).toContainEqual(
    expect.objectContaining({
      text: "+binary target",
      right_line: 2,
      anchored: true,
    }),
  );
}, 30_000);
