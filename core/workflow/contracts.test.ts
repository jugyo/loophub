import { expect, test } from "vitest";
import { workflowStepContracts } from "./contracts.ts";

test("loads every step contract from the canonical Markdown sources", () => {
  const contracts = workflowStepContracts();

  expect(contracts.execute).toContain("# Execute step contract");
  expect(contracts.verify).toContain("# Verify step contract");
});
