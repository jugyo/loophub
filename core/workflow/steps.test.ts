import { expect, test } from "vitest";
import { evaluateWorkflowSteps, workflowDone } from "./steps.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

test("no review, head at base: both steps incomplete with their missing reason", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: false,
    headAheadOfLatestReview: false,
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
    headAheadOfLatestReview: false,
    latestReview: null,
  });
  expect(status.execute).toEqual({ complete: true, missing: [] });
});

test("execute incomplete while the fresh review is still pinned to current head", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    headAheadOfLatestReview: false,
    latestReview: { id: 7, event: "request_changes", headSha: HEAD },
  });
  expect(status.execute.complete).toBe(false);
  expect(status.execute.missing).toEqual([
    "head has not advanced past review 7 (request_changes)",
  ]);
});

test("execute complete again once head advances past the reviewed SHA", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    headAheadOfLatestReview: true,
    latestReview: { id: 7, event: "request_changes", headSha: OLD },
  });
  expect(status.execute).toEqual({ complete: true, missing: [] });
});

test("execute remains incomplete when a stale review is not an ancestor of HEAD", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    headAheadOfLatestReview: false,
    latestReview: { id: 7, event: "request_changes", headSha: OLD },
  });

  expect(status.execute).toEqual({
    complete: false,
    missing: ["head has not advanced past review 7 (request_changes)"],
  });
});

test("verify complete only when the latest review is pinned to current head", () => {
  const status = evaluateWorkflowSteps({
    currentHead: HEAD,
    headAheadOfBase: true,
    headAheadOfLatestReview: false,
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
    headAheadOfLatestReview: true,
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
    headAheadOfLatestReview: false,
    latestReview: { id: 1, event: "pass", headSha: HEAD },
  });
  expect(status.execute.complete).toBe(false);
  expect(status.verify.complete).toBe(false);
  expect(status.verify.latest_review?.fresh).toBe(false);
});

test("Done is a fresh pass on the current HEAD of an open mergeable PR", () => {
  expect(
    workflowDone({
      currentHead: HEAD,
      latestReview: { id: 1, event: "pass", headSha: HEAD },
      prClosed: false,
      prMerged: false,
      mergeConflict: false,
    }),
  ).toBe(true);
});

test.each([
  {
    name: "stale pass",
    latestReview: { id: 1, event: "pass" as const, headSha: OLD },
    prClosed: false,
    prMerged: false,
    mergeConflict: false,
  },
  {
    name: "request changes",
    latestReview: {
      id: 1,
      event: "request_changes" as const,
      headSha: HEAD,
    },
    prClosed: false,
    prMerged: false,
    mergeConflict: false,
  },
  {
    name: "merge conflict",
    latestReview: { id: 1, event: "pass" as const, headSha: HEAD },
    prClosed: false,
    prMerged: false,
    mergeConflict: true,
  },
  {
    name: "closed PR",
    latestReview: { id: 1, event: "pass" as const, headSha: HEAD },
    prClosed: true,
    prMerged: false,
    mergeConflict: false,
  },
  {
    name: "merged PR",
    latestReview: { id: 1, event: "pass" as const, headSha: HEAD },
    prClosed: true,
    prMerged: true,
    mergeConflict: false,
  },
])("Done is false for $name", (input) => {
  expect(workflowDone({ currentHead: HEAD, ...input })).toBe(false);
});
