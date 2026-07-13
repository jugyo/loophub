import { expect, test } from "vitest";
import type { WorkflowVerdictArtifact } from "./artifacts.ts";
import { evaluateWorkflowSteps } from "./steps.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

test("nothing placed: both steps are incomplete with their missing reason", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: false,
    execute: null,
    verify: null,
    latestVerdict: null,
  });
  expect(status.execute).toEqual({
    complete: false,
    missing: [
      "no validated execution-report for current head",
      "head equals base",
    ],
  });
  expect(status.verify).toEqual({
    complete: false,
    missing: ["no validated verdict for current head"],
    latest_verdict: null,
  });
});

test("accepted-but-unplaced artifact stays incomplete", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    execute: { headSha: HEAD, placed: false },
    verify: { headSha: HEAD, placed: false },
    latestVerdict: null,
  });
  expect(status.execute.complete).toBe(false);
  expect(status.verify.complete).toBe(false);
});

test("execute complete only when placed at current head and ahead of base", () => {
  const atHead = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    execute: { headSha: HEAD, placed: true },
    verify: null,
    latestVerdict: null,
  });
  expect(atHead.execute).toEqual({ complete: true, missing: [] });
});

test("execute goes stale when head advances past the stamped SHA", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    execute: { headSha: OLD, placed: true },
    verify: null,
    latestVerdict: null,
  });
  expect(status.execute).toEqual({
    complete: false,
    missing: ["no validated execution-report for current head"],
  });
});

test("verify goes stale when head advances, but latest_verdict still reported", () => {
  const verdict: WorkflowVerdictArtifact = {
    type: "verdict",
    event: "request_changes",
    summary: "Needs work",
    findings: [{ file: "a.ts", problem: "bug", expected: "no bug" }],
  };
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    execute: { headSha: HEAD, placed: true },
    verify: { headSha: OLD, placed: true },
    latestVerdict: verdict,
  });
  expect(status.verify.complete).toBe(false);
  expect(status.verify.missing).toEqual([
    "no validated verdict for current head",
  ]);
  expect(status.verify.latest_verdict).toEqual({
    event: "request_changes",
    summary: "Needs work",
    findings: [{ file: "a.ts", problem: "bug", expected: "no bug" }],
  });
});

test("null current head keeps head-dependent steps incomplete", () => {
  const status = evaluateWorkflowSteps({
    currentHead: null,
    headAheadOfBase: false,
    execute: { headSha: HEAD, placed: true },
    verify: { headSha: HEAD, placed: true },
    latestVerdict: null,
  });
  expect(status.execute.complete).toBe(false);
  expect(status.verify.complete).toBe(false);
});
