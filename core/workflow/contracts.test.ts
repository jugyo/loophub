import { expect, test } from "vitest";
import { workflowContractText, workflowStepContracts } from "./contracts.ts";

test("loads every step contract from the canonical Markdown sources", () => {
  const contracts = workflowStepContracts();

  expect(contracts.execute).toContain("# Execute step contract");
  expect(contracts.verify).toContain("# Verify step contract");
});

test("instructs Execute to submit from trusted launch context without --repo", () => {
  const execute = workflowContractText("execute");

  expect(execute).toMatch(/trusted workflow launch\s+context/u);
  expect(execute).toContain(
    "`lh workflow step output < /path/to/execution-report.json`",
  );
  expect(execute).toContain("Do not add `--repo`");
});

test("keeps optional review aids subordinate to the Verify contract", () => {
  const verify = workflowContractText("verify");

  expect(verify).toContain("authoritative and complete review subject");
  expect(verify).toContain("Do not regenerate, replace, or expand it");
  expect(verify).toContain("optional aid");
  expect(verify).toContain("Standards and Spec");
  expect(verify).toContain("adapted or omitted");
  expect(verify).toContain("review the fixed inputs directly");
  expect(verify).toMatch(
    /map every resulting finding to the verdict\s+schema/u,
  );
});

test("separates Verify context reads from the fixed review subject", () => {
  const verify = workflowContractText("verify");

  expect(verify).toContain("surrounding source code as review context");
  expect(verify).toContain(
    "dependencies, caller and callee contracts, types, invariants, and existing tests",
  );
  expect(verify).toContain("does not expand the review subject");
  expect(verify).toContain(
    "changes in the fixed diff or problems caused by those changes",
  );
  expect(verify).toMatch(
    /unrelated\s+pre-existing source issue as grounds for `request_changes`/u,
  );
  expect(verify).toContain("Do not edit source files");
  expect(verify).toContain("may run tests");
});

test("prefixes every parent-to-child pane injection with orchestrator", () => {
  const parent = workflowContractText("parent");
  const paneRunCommands = parent.match(/`herdr pane run[^`]+`/gu) ?? [];

  expect(paneRunCommands).toHaveLength(4);
  for (const command of paneRunCommands) {
    expect(command).toContain('"orchestrator: ');
  }
});

test("documents the Workflow Herdr names and shared child launch sequence", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("`orchestrator #<run>`");
  expect(parent).toContain("`executor #<run>-<sequence>`");
  expect(parent).toContain("`verifier #<run>-<sequence>`");
  expect(parent).toContain("shared across Execute and Verify");
  expect(parent).toContain("record the `agent` line");
  expect(parent).toContain("`herdr agent get 'executor #<run>-<sequence>'`");
  expect(parent).toContain("`herdr agent get 'verifier #<run>-<sequence>'`");
});

test("identifies orchestrator-prefixed messages in every child contract", () => {
  const contracts = workflowStepContracts();

  for (const contract of Object.values(contracts)) {
    expect(contract).toContain(
      "messages beginning with `orchestrator:` are instructions from the workflow parent",
    );
  }
});

test("parent subscribes its own Herdr pane to GitHub feedback events", () => {
  const contract = workflowContractText("parent");

  expect(contract).toContain(
    "lh subscribe --repo '<repo>' --event pull_request.github_feedback",
  );
  expect(contract).toContain("new or updated GitHub PR feedback");
});
