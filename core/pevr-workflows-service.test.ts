import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-pevr-workflows-"));
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
  const workflow = svc.pevrWorkflows.create({
    name: "  standard  ",
    description: "Default PEVR workflow",
    plan_prompt: "",
    execute_prompt: "Execute carefully",
    verify_prompt: "",
    reflect_prompt: "",
  });

  expect(workflow).toMatchObject({
    name: "standard",
    description: "Default PEVR workflow",
    plan_prompt: "",
    execute_prompt: "Execute carefully",
    verify_prompt: "",
    reflect_prompt: "",
  });
  expect(svc.pevrWorkflows.get("standard").id).toBe(workflow.id);
  expect(svc.pevrWorkflows.list().map((w) => w.name)).toContain("standard");
});

test("name validation rejects blank, long, and duplicate names with 422", () => {
  expectServiceStatus(() => svc.pevrWorkflows.create({ name: " " }), 422);
  expectServiceStatus(
    () => svc.pevrWorkflows.create({ name: "x".repeat(65) }),
    422,
  );
  expectServiceStatus(
    () => svc.pevrWorkflows.create({ name: "standard" }),
    422,
  );
});

test("update patches fields and can rename uniquely", () => {
  svc.pevrWorkflows.create({ name: "other" });
  const updated = svc.pevrWorkflows.update("standard", {
    name: "renamed",
    description: "",
    plan_prompt: "Plan with tests",
  });

  expect(updated.name).toBe("renamed");
  expect(updated.description).toBe("");
  expect(updated.plan_prompt).toBe("Plan with tests");
  expect(updated.execute_prompt).toBe("Execute carefully");
  expectServiceStatus(
    () => svc.pevrWorkflows.update("renamed", { name: "other" }),
    422,
  );
});

test("delete is rejected while a running PEVR run references the workflow", () => {
  const workflow = svc.pevrWorkflows.create({ name: "in-use" });
  const repo = S.createRepo("me/pevr", HOME);
  S.createPevrRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "running",
    currentStep: "plan",
  });

  expectServiceStatus(() => svc.pevrWorkflows.delete("in-use"), 409);
  expect(svc.pevrWorkflows.get("in-use").id).toBe(workflow.id);
});

test("delete is rejected while a blocked PEVR run references the workflow", () => {
  const workflow = svc.pevrWorkflows.create({ name: "blocked-run" });
  const repo = S.createRepo("me/pevr-blocked", HOME);
  S.createPevrRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "blocked",
    currentStep: "verify",
  });

  expectServiceStatus(() => svc.pevrWorkflows.delete("blocked-run"), 409);
  expect(svc.pevrWorkflows.get("blocked-run").id).toBe(workflow.id);
});

test("delete succeeds when no runs reference the workflow", () => {
  svc.pevrWorkflows.create({ name: "unused" });

  expect(svc.pevrWorkflows.delete("unused")).toEqual({ ok: true });
  expectServiceStatus(() => svc.pevrWorkflows.get("unused"), 404);
});

test("delete succeeds when only non-running runs reference the workflow", () => {
  const workflow = svc.pevrWorkflows.create({ name: "done-run" });
  const repo = S.createRepo("me/pevr-done", HOME);
  S.createPevrRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "completed",
    currentStep: "reflect",
  });

  expect(svc.pevrWorkflows.delete("done-run")).toEqual({ ok: true });
  expectServiceStatus(() => svc.pevrWorkflows.get("done-run"), 404);
});
