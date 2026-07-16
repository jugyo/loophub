import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workflowContractText, workflowStepContracts } from "./contracts.ts";

test("loads every step contract from the canonical Markdown sources", () => {
  const contracts = workflowStepContracts();

  expect(contracts.execute).toContain("# Execute step contract");
  expect(contracts.verify).toContain("# Verify step contract");
});

test("Execute pulls domain state itself and declares turn done", () => {
  const execute = workflowContractText("execute");

  expect(execute).toContain("lh issue view <n> --repo '<repo>' --json");
  expect(execute).toContain("lh pr update <pr>");
  expect(execute).toContain(
    "lh workflow turn done --repo '<repo>' --run <run>",
  );
  expect(execute).toContain(
    "lh workflow escalate --repo '<repo>' --run <run> --reason <short summary>",
  );
  expect(execute).toContain("present the full concrete question");
  expect(execute).toContain("in the same pane");
  // The contract retires the artifact / step-output path by name.
  expect(execute).toContain(
    "There is no execution-report artifact and no `lh workflow step output`",
  );
});

test("Verify reviews a fixed base..head diff it computes itself", () => {
  const verify = workflowContractText("verify");

  expect(verify).toContain("git diff <base sha>..<head sha>");
  expect(verify).toContain("authoritative and complete review subject");
  expect(verify).toMatch(/do not\s+substitute/u);
  expect(verify).toContain("optional aid");
  expect(verify).toMatch(/Standards\s+and Spec/u);
  // Output is a pinned PR review, not an artifact.
  expect(verify).toContain("lh pr review <pr>");
  expect(verify).toContain("--commit <head sha>");
  expect(verify).toContain(
    "There is no verdict artifact and no `lh workflow step output`",
  );
});

test("Verify is PR-metadata-blind and documents the deliberate asymmetry", () => {
  const verify = workflowContractText("verify");

  expect(verify).toContain("Why the asymmetry");
  expect(verify).toContain("intentional design choice");
  expect(verify).toContain(
    "Do not read the PR body, PR comments, or the implementer's description",
  );
  expect(verify).toContain(
    "surrounding source code in the worktree as review context",
  );
  expect(verify).toContain("does not expand the review subject");
  expect(verify).toContain("Do not edit source files");
});

test("parent decides transitions by observation, never idle detection", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("lh workflow step status");
  expect(parent).toContain("You do **not** use idle detection");
  expect(parent).toMatch(/never treat a child\s+going idle as a signal/u);
  // The command is named only to forbid it — the run never waits on idle to transition.
  expect(parent).toContain("Do not run `herdr agent wait --status idle`");
});

test("parent delivers rework as a review-id pointer without summarizing findings", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain(
    "Do **not** summarize, quote, or interpret the review's",
  );
  expect(parent).toContain(
    "lh workflow launch-step --repo '<repo>' --run <run> --step execute --review <id>",
  );
});

test("parent launches fresh Execute children instead of injecting or resuming", () => {
  const parent = workflowContractText("parent");

  expect(parent).not.toContain("herdr pane run");
  expect(parent).not.toContain("herdr agent get");
  expect(parent).not.toContain("lh workflow run resume");
  expect(parent).toContain("Never inject into or resume an earlier child");
  expect(parent).toMatch(
    /launch \*\*Verify as a\s+fresh child\*\* — always a new child/u,
  );
});

test("parent polls only its run workflow events and enforces cost limits", () => {
  const contract = workflowContractText("parent");

  expect(contract).toContain(
    "lh events --since <cursor> --repo '<repo>' --type workflow_run --run <run> --order asc --json",
  );
  expect(contract).not.toContain("lh subscribe --repo");
  expect(contract).toContain(
    "The `--type workflow_run --run <run>` filters are mandatory",
  );
  expect(contract).toContain("workflow_run.usage_updated");
  expect(contract).toContain("lh workflow run enforce-cost-limit");
  expect(contract).toContain("sleep briefly and poll again");
});

test("documents fresh child launches without pane addressing", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("always starts a fresh child session");
  expect(parent).toContain("record the new `agent` line");
  expect(parent).not.toContain("pane_id");
});

test("identifies orchestrator-prefixed messages in every child contract", () => {
  const contracts = workflowStepContracts();

  for (const contract of Object.values(contracts)) {
    expect(contract).toContain(
      "messages beginning with `orchestrator:` are instructions from the workflow",
    );
  }
});

test("parent contract does not use pane injection", () => {
  const parent = workflowContractText("parent");

  expect(parent).not.toContain("herdr pane run");
});

test("Japanese workflow design documents the continuing lifecycle after a pass", () => {
  const design = readFileSync(
    join(import.meta.dirname, "..", "..", "docs", "workflow.ja.md"),
    "utf8",
  );

  expect(design).not.toContain("fresh pass review → run completed");
  expect(design).not.toContain("passing verdict で run を completed にする");
  expect(design).toContain("run を `running` のまま維持");
  expect(design).toContain("`run resume` は使わず");
  expect(design).toContain("`--note` 付きで Execute を launch");
  expect(design).toContain(
    "PR body・comment・attachment だけの更新は HEAD を変えない",
  );
  expect(design).toContain("`agent_status: done` でも pane は再利用可能");
  expect(design).toMatch(/修正後の Verify は常に\s+fresh child/u);
  expect(design).toContain("現在の親の通常フローでは使わない");

  for (const event of [
    "workflow_run.turn_done",
    "workflow_run.escalated",
    "workflow_run.review_submitted",
    "workflow_run.github_event",
  ]) {
    expect(design).toContain(event);
  }
  expect(design).toContain(
    "4 種類の通知はいずれも真実を代替しない timing signal",
  );
  expect(design).toContain("`resume --step execute`");
});
