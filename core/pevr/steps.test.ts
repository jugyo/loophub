import { expect, test } from "vitest";
import type { PevrVerdictArtifact } from "./artifacts.ts";
import { evaluatePevrSteps } from "./steps.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

test("nothing placed: every step incomplete with its missing reason", () => {
  const status = evaluatePevrSteps({
    currentHead: HEAD,
    headAheadOfBase: false,
    plan: null,
    execute: null,
    verify: null,
    reflect: null,
    latestVerdict: null,
  });
  expect(status.plan).toEqual({
    complete: false,
    missing: ["no validated plan artifact placed"],
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
  expect(status.reflect).toEqual({
    complete: false,
    missing: ["no validated reflection artifact placed"],
  });
});

test("plan/reflect complete once placed regardless of head", () => {
  const status = evaluatePevrSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    plan: { headSha: OLD, placed: true },
    execute: null,
    verify: null,
    reflect: { headSha: OLD, placed: true },
    latestVerdict: null,
  });
  expect(status.plan.complete).toBe(true);
  expect(status.reflect.complete).toBe(true);
});

test("accepted-but-unplaced artifact stays incomplete", () => {
  const status = evaluatePevrSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    plan: { headSha: HEAD, placed: false },
    execute: { headSha: HEAD, placed: false },
    verify: { headSha: HEAD, placed: false },
    reflect: { headSha: HEAD, placed: false },
    latestVerdict: null,
  });
  expect(status.plan.complete).toBe(false);
  expect(status.execute.complete).toBe(false);
  expect(status.verify.complete).toBe(false);
  expect(status.reflect.complete).toBe(false);
});

test("execute complete only when placed at current head and ahead of base", () => {
  const atHead = evaluatePevrSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    plan: { headSha: HEAD, placed: true },
    execute: { headSha: HEAD, placed: true },
    verify: null,
    reflect: null,
    latestVerdict: null,
  });
  expect(atHead.execute).toEqual({ complete: true, missing: [] });
});

test("execute goes stale when head advances past the stamped SHA", () => {
  const status = evaluatePevrSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    plan: { headSha: OLD, placed: true },
    execute: { headSha: OLD, placed: true },
    verify: null,
    reflect: null,
    latestVerdict: null,
  });
  expect(status.execute).toEqual({
    complete: false,
    missing: ["no validated execution-report for current head"],
  });
});

test("verify goes stale when head advances, but latest_verdict still reported", () => {
  const verdict: PevrVerdictArtifact = {
    type: "verdict",
    event: "request_changes",
    summary: "Needs work",
    findings: [{ file: "a.ts", problem: "bug", expected: "no bug" }],
  };
  const status = evaluatePevrSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    plan: { headSha: HEAD, placed: true },
    execute: { headSha: HEAD, placed: true },
    verify: { headSha: OLD, placed: true },
    reflect: null,
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
  const status = evaluatePevrSteps({
    currentHead: null,
    headAheadOfBase: false,
    plan: { headSha: HEAD, placed: true },
    execute: { headSha: HEAD, placed: true },
    verify: { headSha: HEAD, placed: true },
    reflect: { headSha: HEAD, placed: true },
    latestVerdict: null,
  });
  expect(status.plan.complete).toBe(true);
  expect(status.reflect.complete).toBe(true);
  expect(status.execute.complete).toBe(false);
  expect(status.verify.complete).toBe(false);
});
