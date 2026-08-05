import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-workflows-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

function expectServiceStatus(fn: () => unknown, status: number): void {
  try {
    fn();
  } catch (e) {
    expect(e).toMatchObject({ status });
    return;
  }
  throw new Error(`expected ServiceError ${status}`);
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("create trims name and preserves empty markdown prompts", () => {
  const workflow = svc.workflows.create({
    name: "  standard  ",
    description: "Default workflow",
    execute_prompt: "Execute carefully",
    verify_prompt: "",
  });

  expect(workflow).toMatchObject({
    name: "standard",
    description: "Default workflow",
    execute_prompt: "Execute carefully",
    verify_prompt: "",
  });
  expect(svc.workflows.get("standard").id).toBe(workflow.id);
  expect(svc.workflows.list().map((w) => w.name)).toContain("standard");
});

test("name validation rejects blank, long, and duplicate names with 422", () => {
  expectServiceStatus(() => svc.workflows.create({ name: " " }), 422);
  expectServiceStatus(
    () => svc.workflows.create({ name: "x".repeat(65) }),
    422,
  );
  expectServiceStatus(() => svc.workflows.create({ name: "standard" }), 422);
});

test("repository workflows override same-name global workflows when selecting applicable workflows", () => {
  const repoA = S.createRepo("me/workflows-a", HOME);
  const repoB = S.createRepo("me/workflows-b", HOME);
  const repoC = S.createRepo("me/workflows-c", HOME);
  const global = svc.workflows.create({ name: "scoped" });
  const scopedA = svc.workflows.create({
    name: "scoped",
    repo: repoA.full_name,
  });
  const scopedB = svc.workflows.create({
    name: "scoped",
    repo: repoB.full_name,
  });

  expect(global.scope).toEqual({ kind: "global" });
  expect(scopedA.scope).toEqual({
    kind: "repository",
    repo: { id: repoA.id, owner: "me", name: "workflows-a" },
  });
  expectServiceStatus(
    () => svc.workflows.create({ name: "scoped", repo: repoA.full_name }),
    422,
  );
  expect(
    svc.workflows
      .list({ applicableTo: repoA.full_name })
      .filter((workflow) => workflow.name === "scoped")
      .map((workflow) => workflow.id),
  ).toEqual([scopedA.id]);
  expect(
    svc.workflows
      .list({ applicableTo: repoB.full_name })
      .filter((workflow) => workflow.name === "scoped")
      .map((workflow) => workflow.id),
  ).toEqual([scopedB.id]);
  expect(
    svc.workflows
      .list({ applicableTo: repoC.full_name })
      .filter((workflow) => workflow.name === "scoped")
      .map((workflow) => workflow.id),
  ).toEqual([global.id]);
  expect(
    svc.workflows
      .list({ scope: { repo: repoB.full_name } })
      .map((workflow) => workflow.id),
  ).toEqual([scopedB.id]);

  svc.workflows.archiveById(scopedA.id);
  expect(
    svc.workflows
      .list({ applicableTo: repoA.full_name })
      .filter((workflow) => workflow.name === "scoped")
      .map((workflow) => workflow.id),
  ).toEqual([global.id]);
});

test("update patches fields and can rename uniquely", () => {
  svc.workflows.create({ name: "other" });
  const updated = svc.workflows.update("standard", {
    name: "renamed",
    description: "",
    verify_prompt: "Verify with tests",
  });

  expect(updated.name).toBe("renamed");
  expect(updated.description).toBe("");
  expect(updated.verify_prompt).toBe("Verify with tests");
  expect(updated.execute_prompt).toBe("Execute carefully");
  expectServiceStatus(
    () => svc.workflows.update("renamed", { name: "other" }),
    422,
  );
});

test("archive preserves the workflow and run reference while excluding it from the active list", () => {
  const workflow = svc.workflows.create({ name: "archive-me" });
  const repo = S.createRepo("me/workflow-archive", HOME);
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 10,
    costLimitUsd: 10,
  });

  const archived = svc.workflows.archive("archive-me");

  expect(archived.archived_at).toBeTruthy();
  expect(svc.workflows.get("archive-me")).toEqual(archived);
  expect(svc.workflows.list().map((item) => item.name)).not.toContain(
    "archive-me",
  );
  expect(S.getWorkflowRun(run.id)?.workflow_id).toBe(workflow.id);
});

// A run and the issue / PR pair it is pinned to. Whether the run is still active is read from the
// PR, so the delete guard needs the real rows rather than a run row on its own.
function runWithPull(input: {
  workflowId: number;
  repoName: string;
  currentStep: string;
}) {
  const repo = S.createRepo(input.repoName, HOME);
  const issue = S.createIssue(repo.id, "issue", "Issue", "", "me");
  const prIssue = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(prIssue.id, "head", "main", null, issue.id);
  const run = S.createWorkflowRun({
    workflowId: input.workflowId,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: prIssue.number,
    status: "running",
    currentStep: input.currentStep,
    costIncrementUsd: 10,
    costLimitUsd: 10,
  });
  return { repo, issue, prIssue, run };
}

test("delete is rejected while a run with an open PR references the workflow", () => {
  const workflow = svc.workflows.create({ name: "in-use" });
  const { run } = runWithPull({
    workflowId: workflow.id,
    repoName: "me/workflow",
    currentStep: "execute",
  });
  expect(run.contract_language).toBe("en");

  expectServiceStatus(() => svc.workflows.delete("in-use"), 409);
  expect(svc.workflows.get("in-use").id).toBe(workflow.id);
});

test("delete is rejected while a run waiting for a human references the workflow", () => {
  const workflow = svc.workflows.create({ name: "needs-human-run" });
  const { run } = runWithPull({
    workflowId: workflow.id,
    repoName: "me/workflow-needs-human",
    currentStep: "verify",
  });
  // Waiting for a human leaves the PR open, so the run stays active (#1307).
  S.updateWorkflowRun(run.id, { needsHumanReason: "rework limit exceeded" });

  expectServiceStatus(() => svc.workflows.delete("needs-human-run"), 409);
  expect(svc.workflows.get("needs-human-run").id).toBe(workflow.id);
});

test("delete succeeds when no runs reference the workflow", () => {
  svc.workflows.create({ name: "unused" });

  expect(svc.workflows.delete("unused")).toEqual({ ok: true });
  expectServiceStatus(() => svc.workflows.get("unused"), 404);
});

test("delete succeeds when every run's PR is closed", () => {
  const workflow = svc.workflows.create({ name: "closed-run" });
  const { prIssue } = runWithPull({
    workflowId: workflow.id,
    repoName: "me/workflow-closed",
    currentStep: "verify",
  });
  S.updateIssue(prIssue.id, { state: "closed" });

  expect(svc.workflows.delete("closed-run")).toEqual({ ok: true });
  expectServiceStatus(() => svc.workflows.get("closed-run"), 404);
});

test("delete succeeds when every run's PR is merged", () => {
  const workflow = svc.workflows.create({ name: "merged-run" });
  const { prIssue } = runWithPull({
    workflowId: workflow.id,
    repoName: "me/workflow-merged",
    currentStep: "verify",
  });
  S.setMerged(prIssue.id, "deadbeef", "merge");

  expect(svc.workflows.delete("merged-run")).toEqual({ ok: true });
  expectServiceStatus(() => svc.workflows.get("merged-run"), 404);
});
