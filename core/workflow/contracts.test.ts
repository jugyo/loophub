import { expect, test } from "vitest";
import { workflowContractText, workflowStepContracts } from "./contracts.ts";

test("loads every step contract from the canonical Markdown sources", () => {
  const contracts = workflowStepContracts();

  expect(contracts.plan).toBe(workflowContractText("plan"));
  expect(contracts.execute).toContain("# Execute step contract");
  expect(contracts.verify).toContain("# Verify step contract");
  expect(contracts.reflect).toContain("# Reflect step contract");
});
