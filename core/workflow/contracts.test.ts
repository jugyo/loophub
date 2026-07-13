import { expect, test } from "vitest";
import { workflowContractText, workflowStepContracts } from "./contracts.ts";

test("loads every step contract from the canonical Markdown sources", () => {
  const contracts = workflowStepContracts();

  expect(contracts.execute).toContain("# Execute step contract");
  expect(contracts.verify).toContain("# Verify step contract");
});

test("prefixes every parent-to-child pane injection with orchestrator", () => {
  const parent = workflowContractText("parent");
  const paneRunCommands = parent.match(/`herdr pane run[^`]+`/gu) ?? [];

  expect(paneRunCommands).toHaveLength(3);
  for (const command of paneRunCommands) {
    expect(command).toContain('"orchestrator: ');
  }
});

test("identifies orchestrator-prefixed messages in every child contract", () => {
  const contracts = workflowStepContracts();

  for (const contract of Object.values(contracts)) {
    expect(contract).toContain(
      "messages beginning with `orchestrator:` are instructions from the workflow parent",
    );
  }
});
