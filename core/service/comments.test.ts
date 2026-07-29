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

test("classifies PR commenters and only notifies the workflow for a human", async () => {
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
  const notifications = store
    .eventsForWorkflowRun(repoId, runId)
    .filter((event) => event.type === "workflow_run.pr_comment");
  expect(notifications).toHaveLength(1);
  expect(notifications[0].actor).toBe("me");
  expect(JSON.parse(notifications[0].payload)).toMatchObject({
    id: runId,
    pr_number: prNumber,
    parent_session_id: parentSession,
    comment_id: human.id,
    author: "me",
    body: "Please rename this.",
  });
  const next = await svc.workflowRuns.next(repoName, {
    run: runId,
    event: notifications[0].id,
  });
  expect(next).toMatchObject({
    action: "deliver",
    delivery_reason: "pr_comment",
    comment_id: human.id,
  });
  expect(next.instructions.commands[0]?.args).toContain(
    `orchestrator: address PR comment #${human.id}`,
  );

  const detail = await svc.pulls.get(repoName, prNumber);
  expect(detail.comment_list).toEqual([human, agent, system]);
});
