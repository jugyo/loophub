import { expect, test } from "vitest";
import {
  buildCritReview,
  type CritComment,
  parseCritComments,
} from "./crit-comments.ts";

test("parseCritComments treats an empty review (null / [] / blank) as no comments", () => {
  // crit prints the literal `null` when there are no unresolved comments (or no review file).
  expect(parseCritComments("null")).toEqual([]);
  expect(parseCritComments("[]")).toEqual([]);
  expect(parseCritComments("")).toEqual([]);
  expect(parseCritComments("   \n")).toEqual([]);
  expect(parseCritComments("not json")).toEqual([]);
});

test("parseCritComments returns the flat array as-is", () => {
  const raw = `[
    {"scope":"line","path":"a.ts","start_line":2,"end_line":2,"body":"x"}
  ]`;
  expect(parseCritComments(raw)).toEqual([
    { scope: "line", path: "a.ts", start_line: 2, end_line: 2, body: "x" },
  ]);
});

test("buildCritReview returns null when there are no unresolved comments", () => {
  expect(buildCritReview([])).toBeNull();
});

test("buildCritReview folds review-level into body and file/line into comments", () => {
  const comments: CritComment[] = [
    { scope: "review", start_line: 0, end_line: 0, body: "overall feedback" },
    {
      scope: "file",
      path: "a.ts",
      start_line: 0,
      end_line: 0,
      body: "file note",
    },
    {
      scope: "line",
      path: "a.ts",
      start_line: 2,
      end_line: 2,
      body: "line 2 issue",
    },
    {
      scope: "line",
      path: "b.ts",
      start_line: 4,
      end_line: 5,
      body: "range issue",
    },
  ];
  expect(buildCritReview(comments)).toEqual({
    body: "overall feedback",
    comments: [
      // file-level: start_line 0 → no line
      { path: "a.ts", line: undefined, body: "file note" },
      { path: "a.ts", line: 2, body: "line 2 issue" },
      { path: "b.ts", line: 4, body: "range issue" },
    ],
  });
});

test("buildCritReview joins multiple review-level comments into one body", () => {
  const comments: CritComment[] = [
    { scope: "review", body: "first" },
    { scope: "review", body: "second" },
  ];
  expect(buildCritReview(comments)).toEqual({
    body: "first\n\nsecond",
    comments: [],
  });
});

test("buildCritReview treats a comment with no path as review-level", () => {
  // Defensive: classify by scope OR the absence of a path.
  const comments: CritComment[] = [{ body: "no scope, no path" }];
  expect(buildCritReview(comments)).toEqual({
    body: "no scope, no path",
    comments: [],
  });
});

test("buildCritReview keeps only line comments, leaving an empty body", () => {
  const comments: CritComment[] = [
    { scope: "line", path: "a.ts", start_line: 7, end_line: 7, body: "fix" },
  ];
  expect(buildCritReview(comments)).toEqual({
    body: "",
    comments: [{ path: "a.ts", line: 7, body: "fix" }],
  });
});
