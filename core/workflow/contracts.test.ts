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

  expect(parent).toContain('"orchestrator: address review #<id>"');
  expect(parent).toMatch(
    /Do \*\*not\*\* summarize,\s+quote, or interpret the review's findings/u,
  );
  expect(parent).toContain(
    "lh workflow launch-step --repo '<repo>' --run <run> --step execute --review <id>",
  );
});

test("parent subscribes its pane to workflow observation and GitHub feedback events", () => {
  const contract = workflowContractText("parent");

  expect(contract).toContain(
    "lh subscribe --repo '<repo>' --event workflow_run.turn_done",
  );
  expect(contract).toContain(
    "lh subscribe --repo '<repo>' --event workflow_run.review_submitted",
  );
  expect(contract).toContain(
    "lh subscribe --repo '<repo>' --event pull_request.github_feedback",
  );
  expect(contract).toContain("only a signal to observe");
});

test("documents the Workflow Herdr names and shared child launch sequence", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("`orchestrator #<run>`");
  expect(parent).toContain("`executor #<run>-<sequence>`");
  expect(parent).toContain("`verifier #<run>-<sequence>`");
  expect(parent).toMatch(/shared across Execute\s+and Verify/u);
  expect(parent).toMatch(/record the `agent`\s+line/u);
});

test("identifies orchestrator-prefixed messages in every child contract", () => {
  const contracts = workflowStepContracts();

  for (const contract of Object.values(contracts)) {
    expect(contract).toContain(
      "messages beginning with `orchestrator:` are instructions from the workflow",
    );
  }
});

test("every parent-to-child pane injection is orchestrator-prefixed", () => {
  const parent = workflowContractText("parent");
  const paneRunCommands = parent.match(/`herdr pane run[^`]+`/gu) ?? [];

  expect(paneRunCommands.length).toBeGreaterThan(0);
  for (const command of paneRunCommands) {
    expect(command).toContain('"orchestrator: ');
  }
});
