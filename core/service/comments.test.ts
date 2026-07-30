import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-pr-comments-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "test.db");

const repoName = "me/pr-comments";
const parentSession = "11111111-1111-4111-8111-111111111111";
const agentSession = "22222222-2222-4222-8222-222222222222";

let svc: typeof import("../service.ts");
let store: typeof import("../store.ts");
let database: typeof import("../db.ts")["db"];
let repoPath: string;
let repoId: number;
let prNumber: number;
let runId: number;

function git(args: string[]) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

beforeAll(async () => {
  svc = await import("../service.ts");
  store = await import("../store.ts");
  ({ db: database } = await import("../db.ts"));
  repoPath = mkdtempSync(join(tmpdir(), "lh-pr-comments-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repoPath, "a.txt"), "base\n");
  git(["add", "a.txt"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "feature"]);
  writeFileSync(join(repoPath, "a.txt"), "feature\n");
  git(["add", "a.txt"]);
  git(["commit", "-qm", "feature"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: repoName });
  repoId = (await svc.repos.get(repoName)).id;
  prNumber = (
    await svc.pulls.create(repoName, {
      title: "Comment target",
      head: "feature",
      base: "main",
    })
  ).number;
  store.registerAgentSession(
    agentSession,
    "codex",
    "agent-runtime",
    "executor #1-1",
  );
  const workflow = store.createWorkflow({
    name: "PR comment workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  runId = store.createWorkflowRun({
    workflowId: workflow.id,
    repoId,
    issueNumber: prNumber,
    prNumber,
    status: "running",
    currentStep: "execute",
    parentSessionId: parentSession,
    costIncrementUsd: 10,
    costLimitUsd: 10,
  }).id;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("classifies PR commenters and only instructs the workflow for a human", async () => {
  const human = svc.comments.createHumanForPull(
    repoName,
    prNumber,
    "Please rename this.",
  );
  const agent = svc.comments.createForPull(
    repoName,
    prNumber,
    "Implemented.",
    agentSession,
  );
  const system = svc.comments.createForPull(
    repoName,
    prNumber,
    "Automated note.",
  );

  expect([human.author_type, agent.author_type, system.author_type]).toEqual([
    "human",
    "agent",
    "system",
  ]);
  // No run-scoped twin is written any more: the run reads `author_type` off the source event and
  // decides for itself which comment is an instruction.
  expect(
    store
      .eventsForWorkflowRun(repoId, runId)
      .filter((event) => event.type === "workflow_run.pr_comment"),
  ).toEqual([]);
  const sources = store
    .eventsForPull(repoId, prNumber, null)
    .filter((event) => event.type === "pull_request.commented")
    .reverse();
  expect(sources).toHaveLength(3);
  expect(JSON.parse(sources[0].payload)).toMatchObject({
    number: prNumber,
    comment_id: human.id,
    author_type: "human",
    source_payload_version: 1,
  });
  const next = await svc.workflowRuns.next(repoName, {
    run: runId,
    event: sources[0].id,
  });
  expect(next).toMatchObject({
    action: "deliver",
    delivery_reason: "pr_comment",
    comment_id: human.id,
  });
  // An agent's own comment is selected too, but reconciles to state observation only.
  const agentWake = await svc.workflowRuns.next(repoName, {
    run: runId,
    event: sources[1].id,
  });
  expect(agentWake.action).not.toBe("deliver");
  expect(next.instructions.commands[0]?.args).toEqual([
    "pr",
    "comment",
    "react",
    String(human.id),
    "--pr",
    String(prNumber),
    "--emoji",
    "👀",
    "--repo",
    repoName,
  ]);
  expect(next.instructions.commands[1]?.args).toContain(
    `orchestrator: address PR comment #${human.id}`,
  );

  const detail = await svc.pulls.get(repoName, prNumber);
  expect(detail.comment_list).toEqual([human, agent, system]);
});

test("a supported PR comment reaction can be added, changed, and removed", () => {
  const comment = svc.comments.createHumanForPull(
    repoName,
    prNumber,
    "Please acknowledge this.",
  );

  const added = svc.comments.reactForPull(
    repoName,
    prNumber,
    comment.id,
    "👀",
    agentSession,
  );
  const human = svc.comments.reactHumanForPull(
    repoName,
    prNumber,
    comment.id,
    "👀",
  );
  const changed = svc.comments.reactForPull(
    repoName,
    prNumber,
    comment.id,
    "🚀",
    agentSession,
  );
  const removed = svc.comments.reactForPull(
    repoName,
    prNumber,
    comment.id,
    "🚀",
    agentSession,
  );

  expect(added.reactions).toEqual([{ emoji: "👀", count: 1, reacted: true }]);
  expect(human.reactions).toEqual([{ emoji: "👀", count: 2, reacted: true }]);
  expect(changed.reactions).toEqual(
    expect.arrayContaining([
      { emoji: "👀", count: 1, reacted: false },
      { emoji: "🚀", count: 1, reacted: true },
    ]),
  );
  expect(removed.reactions).toEqual([
    { emoji: "👀", count: 1, reacted: false },
  ]);
  expect(svc.comments.list(repoName, prNumber).at(-1)?.reactions).toEqual([
    { emoji: "👀", count: 1, reacted: false },
  ]);
  expect(() =>
    svc.comments.reactForPull(
      repoName,
      prNumber,
      comment.id,
      "unsupported",
      agentSession,
    ),
  ).toThrow("unsupported PR comment reaction");
});

test("a failed PR comment reaction change preserves the existing reaction", () => {
  const comment = svc.comments.createHumanForPull(
    repoName,
    prNumber,
    "Keep this reaction.",
  );
  svc.comments.reactForPull(repoName, prNumber, comment.id, "👀", agentSession);
  database.exec(`
    CREATE TEMP TRIGGER fail_comment_reaction_update
    BEFORE UPDATE ON comment_reactions
    BEGIN
      SELECT RAISE(ABORT, 'forced reaction update failure');
    END
  `);
  try {
    expect(() =>
      svc.comments.reactForPull(
        repoName,
        prNumber,
        comment.id,
        "🚀",
        agentSession,
      ),
    ).toThrow("forced reaction update failure");
  } finally {
    database.exec("DROP TRIGGER fail_comment_reaction_update");
  }

  expect(
    svc.comments.list(repoName, prNumber, "executor #1-1").at(-1)?.reactions,
  ).toEqual([{ emoji: "👀", count: 1, reacted: true }]);
});
