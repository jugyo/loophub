import { expect, test } from "vitest";
import {
  canHaveSubIssues,
  effectiveWorkspace,
  type IssueFacts,
  MAX_ISSUE_DEPTH,
  rejectAttach,
} from "./issue-hierarchy.ts";

const issue = (overrides: Partial<IssueFacts> = {}): IssueFacts => ({
  id: 1,
  number: 1,
  repoId: 10,
  kind: "issue",
  targetBranch: null,
  ...overrides,
});

const attach = (overrides: Partial<Parameters<typeof rejectAttach>[0]> = {}) =>
  rejectAttach({
    child: issue({ id: 2, number: 2 }),
    parent: issue(),
    parentAncestorNumbers: [1],
    childSubtreeHeight: 1,
    defaultBranch: "main",
    ...overrides,
  });

test("effectiveWorkspace uses the target branch or the repository default", () => {
  expect(effectiveWorkspace("release", "main")).toBe("release");
  expect(effectiveWorkspace(null, "main")).toBe("main");
});

test("canHaveSubIssues allows only parents below the maximum depth", () => {
  expect(canHaveSubIssues(MAX_ISSUE_DEPTH - 1)).toBe(true);
  expect(canHaveSubIssues(MAX_ISSUE_DEPTH)).toBe(false);
});

test("I1 rejects a pull parent and allows an issue parent", () => {
  expect(attach({ parent: issue({ kind: "pull" }) })).toEqual({
    kind: "not_an_issue",
  });
  expect(attach({ child: issue({ id: 2, number: 2, kind: "pull" }) })).toEqual({
    kind: "not_an_issue",
  });
  expect(attach()).toBeNull();
});

test("I2 rejects different repositories and allows the same repository", () => {
  expect(attach({ child: issue({ id: 2, repoId: 11 }) })).toEqual({
    kind: "cross_repo",
  });
  expect(attach()).toBeNull();
});

test("I3 rejects the same issue and allows distinct issues", () => {
  expect(attach({ child: issue() })).toEqual({ kind: "self" });
  expect(attach()).toBeNull();
});

test("I4 rejects an ancestor cycle and allows a non-ancestor", () => {
  expect(
    attach({
      child: issue({ id: 2, number: 7 }),
      parentAncestorNumbers: [1, 7, 4],
    }),
  ).toEqual({ kind: "cycle", ancestorNumber: 7 });
  expect(attach({ parentAncestorNumbers: [1] })).toBeNull();
});

test("I5 rejects different workspaces and allows matching effective workspaces", () => {
  expect(
    attach({
      parent: issue({ targetBranch: "release" }),
      child: issue({ id: 2, number: 2, targetBranch: "main" }),
    }),
  ).toEqual({
    kind: "workspace_mismatch",
    parentWorkspace: "release",
    childWorkspace: "main",
  });
  expect(
    attach({
      parent: issue({ targetBranch: "release" }),
      child: issue({ id: 2, number: 2, targetBranch: "release" }),
    }),
  ).toBeNull();
  expect(
    attach({
      parent: issue({ targetBranch: null }),
      child: issue({ id: 2, number: 2, targetBranch: null }),
    }),
  ).toBeNull();
});

test("I6 enforces parent depth and child subtree height", () => {
  expect(
    attach({
      parentAncestorNumbers: [1, 4],
    }),
  ).toEqual({ kind: "parent_too_deep", parentDepth: MAX_ISSUE_DEPTH });

  // A depth-two parent plus a leaf child reaches, but does not exceed, the limit.
  expect(
    attach({
      parentAncestorNumbers: [1],
      childSubtreeHeight: 1,
    }),
  ).toBeNull();

  // A depth-two parent plus a two-level child subtree exceeds the limit.
  expect(
    attach({
      parentAncestorNumbers: [1],
      childSubtreeHeight: 2,
    }),
  ).toEqual({
    kind: "child_subtree_too_tall",
    parentDepth: 2,
    childHeight: 2,
  });

  // A depth-one parent can accept a two-level child subtree.
  expect(
    attach({
      parentAncestorNumbers: [],
      childSubtreeHeight: 2,
    }),
  ).toBeNull();
});
