import { expect, test } from "vitest";
import { evaluateWorkflowSteps } from "./steps.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

test("no review, head at base: both steps incomplete with their missing reason", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: false,
    latestReview: null,
  });
  expect(status.execute).toEqual({
    complete: false,
    missing: ["head equals base"],
  });
  expect(status.verify).toEqual({
    complete: false,
    missing: ["no workflow review pinned to current head"],
    latest_review: null,
  });
});

test("execute complete when head ahead of base and no review yet", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    latestReview: null,
  });
  expect(status.execute).toEqual({ complete: true, missing: [] });
});

test("execute incomplete while the fresh review is still pinned to current head", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    latestReview: { id: 7, event: "request_changes", headSha: HEAD },
  });
  expect(status.execute.complete).toBe(false);
  expect(status.execute.missing).toEqual([
    "head has not advanced past review #7 (request_changes)",
  ]);
});

test("execute complete again once head advances past the reviewed SHA", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    latestReview: { id: 7, event: "request_changes", headSha: OLD },
  });
  expect(status.execute).toEqual({ complete: true, missing: [] });
});

test("verify complete only when the latest review is pinned to current head", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    latestReview: { id: 9, event: "pass", headSha: HEAD },
  });
  expect(status.verify.complete).toBe(true);
  expect(status.verify.latest_review).toEqual({
    id: 9,
    event: "pass",
    headSha: HEAD,
    fresh: true,
  });
});

test("verify goes stale when head advances, but latest_review still reported", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    latestReview: { id: 4, event: "request_changes", headSha: OLD },
  });
  expect(status.verify.complete).toBe(false);
  expect(status.verify.missing).toEqual([
    "no workflow review pinned to current head",
  ]);
  expect(status.verify.latest_review).toEqual({
    id: 4,
    event: "request_changes",
    headSha: OLD,
    fresh: false,
  });
});

test("null current head keeps head-dependent steps incomplete", () => {
  const status = evaluateWorkflowSteps({
    currentHead: null,
    headAheadOfBase: false,
    latestReview: { id: 1, event: "pass", headSha: HEAD },
  });
  expect(status.execute.complete).toBe(false);
  expect(status.verify.complete).toBe(false);
  expect(status.verify.latest_review?.fresh).toBe(false);
});
