import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

// The parent agent's `lh` calls, exercised the way it makes them: from a cwd that is not the repo
// and with the free text on stdin.
const CLI = join(import.meta.dirname, "index.ts");
const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-parent-home-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-parent-repo-"));
const NEUTRAL_CWD = mkdtempSync(join(tmpdir(), "lh-workflow-parent-cwd-"));

process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "loophub.db");

let S: typeof import("../core/store.ts");
let workflowId: number;
let repoId: number;

function lh(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: NEUTRAL_CWD,
    encoding: "utf8",
    env: process.env,
    input,
    timeout: 20_000,
  });
}

function createRun(): { run: number; pr: number } {
  const issue = S.createIssue(repoId, "issue", "parent", "", "me");
  const prIssue = S.createIssue(repoId, "pull", "parent pr", "", "me");
  S.createPull(
    prIssue.id,
    `loophub/pr-${prIssue.number}`,
    "main",
    null,
    issue.id,
  );
  const run = S.createWorkflowRun({
    workflowId,
    repoId,
    issueNumber: issue.number,
    prNumber: prIssue.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 1,
    costLimitUsd: 1,
  });
  return { run: run.id, pr: prIssue.number };
}

beforeAll(async () => {
  S = await import("../core/store.ts");
  const repo = S.createRepo("me/workflow-parent", REPO_PATH);
  repoId = repo.id;
  workflowId = S.createWorkflow({
    name: "parent-commands",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  }).id;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
  rmSync(NEUTRAL_CWD, { recursive: true, force: true });
});

test("a run-scoped workflow command resolves its repo from the run", () => {
  const { run } = createRun();

  const status = lh(["workflow", "step", "status", String(run), "--json"]);

  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout).run).toBe(run);
});

test("escalate-human takes its reason from stdin, with or without the flag", () => {
  const withFlag = createRun();
  const dashed = lh(
    [
      "workflow",
      "escalate-human",
      "--run",
      String(withFlag.run),
      "--reason",
      "-",
    ],
    "Background: 前提が未確定。 Decision points: 人間が決める。",
  );
  expect(dashed.status, dashed.stderr).toBe(0);
  expect(
    S.listComments(S.getIssue(repoId, withFlag.pr)!.id)[0]?.body,
  ).toContain("Background: 前提が未確定。");

  // The flag itself goes missing when a multi-line body is quoted wrong.
  const withoutFlag = createRun();
  const redirected = lh(
    ["workflow", "escalate-human", "--run", String(withoutFlag.run)],
    "Background: 別の判断が要る。\nDecision points: 人間が決める。",
  );
  expect(redirected.status, redirected.stderr).toBe(0);
  expect(
    S.listComments(S.getIssue(repoId, withoutFlag.pr)!.id)[0]?.body,
  ).toContain("Background: 別の判断が要る。 Decision points: 人間が決める。");
});

test("escalate-human still reports a reason it was never given", () => {
  const { run } = createRun();

  const missing = lh(["workflow", "escalate-human", "--run", String(run)]);

  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("escalate-human requires --reason");
});
