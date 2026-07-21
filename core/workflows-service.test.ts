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

test("delete is rejected while a running Workflow run references the workflow", () => {
  const workflow = svc.workflows.create({ name: "in-use" });
  const repo = S.createRepo("me/workflow", HOME);
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "running",
    currentStep: "execute",
  });
  expect(run.contract_language).toBe("en");

  expectServiceStatus(() => svc.workflows.delete("in-use"), 409);
  expect(svc.workflows.get("in-use").id).toBe(workflow.id);
});

test("delete is rejected while a run waiting for a human references the workflow", () => {
  const workflow = svc.workflows.create({ name: "needs-human-run" });
  const repo = S.createRepo("me/workflow-needs-human", HOME);
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "running",
    currentStep: "verify",
  });
  // Waiting for a human keeps the run `running`, so it stays active (#1307).
  S.updateWorkflowRun(run.id, { needsHumanReason: "rework limit exceeded" });

  expectServiceStatus(() => svc.workflows.delete("needs-human-run"), 409);
  expect(svc.workflows.get("needs-human-run").id).toBe(workflow.id);
});

test("delete succeeds when only a legacy blocked run references the workflow", () => {
  const workflow = svc.workflows.create({ name: "legacy-blocked-run" });
  const repo = S.createRepo("me/workflow-legacy-blocked", HOME);
  S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "blocked",
    currentStep: "verify",
  });

  // Legacy `blocked` is terminal (#1307): its parent session is gone, so it is not active.
  svc.workflows.delete("legacy-blocked-run");
  expectServiceStatus(() => svc.workflows.get("legacy-blocked-run"), 404);
});

test("delete succeeds when no runs reference the workflow", () => {
  svc.workflows.create({ name: "unused" });

  expect(svc.workflows.delete("unused")).toEqual({ ok: true });
  expectServiceStatus(() => svc.workflows.get("unused"), 404);
});

test("delete succeeds when only non-running runs reference the workflow", () => {
  const workflow = svc.workflows.create({ name: "done-run" });
  const repo = S.createRepo("me/workflow-done", HOME);
  S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "completed",
    currentStep: "verify",
  });

  expect(svc.workflows.delete("done-run")).toEqual({ ok: true });
  expectServiceStatus(() => svc.workflows.get("done-run"), 404);
});
