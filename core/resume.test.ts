import { expect, test } from "vitest";
import {
  decideResume,
  isClaudeSessionId,
  resumeWorktreeIssue,
} from "./resume.ts";

// decideResume: the restorability judgment for `lh resume`. No session id is terminal; an
// existing worktree is reused; otherwise a surviving branch is restored; with neither, give up.
test("decideResume: missing session id is terminal", () => {
  expect(
    decideResume({ sessionId: null, worktreeExists: true, branchExists: true }),
  ).toEqual({ ok: false, reason: "no-session" });
  // even an empty string counts as no recorded session
  expect(
    decideResume({ sessionId: "", worktreeExists: true, branchExists: true }),
  ).toEqual({ ok: false, reason: "no-session" });
});

test("decideResume: existing worktree is reused (no restore)", () => {
  expect(
    decideResume({
      sessionId: "s",
      worktreeExists: true,
      branchExists: false,
    }),
  ).toEqual({ ok: true, restore: false });
});

test("decideResume: missing worktree but surviving branch restores", () => {
  expect(
    decideResume({
      sessionId: "s",
      worktreeExists: false,
      branchExists: true,
    }),
  ).toEqual({ ok: true, restore: true });
});

test("decideResume: no worktree and no branch is unrestorable", () => {
  expect(
    decideResume({
      sessionId: "s",
      worktreeExists: false,
      branchExists: false,
    }),
  ).toEqual({ ok: false, reason: "unrestorable" });
});

// resumeWorktreeIssue: the head branch (lh-dev convention) is the most direct source, then the
// linked issue, then the PR's own number.
test("resumeWorktreeIssue: prefers the lh-dev branch convention", () => {
  expect(resumeWorktreeIssue("loophub/issue-7", 3, 9)).toBe(7);
});

test("resumeWorktreeIssue: falls back to the linked issue for an off-convention branch", () => {
  expect(resumeWorktreeIssue("feature-x", 3, 9)).toBe(3);
  expect(resumeWorktreeIssue(null, 3, 9)).toBe(3);
});

test("resumeWorktreeIssue: falls back to the PR number when nothing else resolves", () => {
  expect(resumeWorktreeIssue("feature-x", null, 9)).toBe(9);
  expect(resumeWorktreeIssue(null, null, 9)).toBe(9);
});

// isClaudeSessionId: only a UUID is a resumable Claude session id; a flag-like or malformed value
// must be rejected so it can never reach `claude --resume` as a spoofed flag.
test("isClaudeSessionId accepts a UUID", () => {
  expect(isClaudeSessionId("d8a43602-f469-4b03-8fa8-0af5200f22b3")).toBe(true);
  expect(isClaudeSessionId("11111111-1111-4111-8111-111111111111")).toBe(true);
});

test("isClaudeSessionId rejects flag-like, malformed, and empty ids", () => {
  expect(isClaudeSessionId("--dangerously-skip-permissions")).toBe(false);
  expect(isClaudeSessionId("-r")).toBe(false);
  expect(isClaudeSessionId("not-a-uuid")).toBe(false);
  expect(isClaudeSessionId("")).toBe(false);
  expect(isClaudeSessionId(null)).toBe(false);
  expect(isClaudeSessionId(undefined)).toBe(false);
});
