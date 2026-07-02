import { expect, test } from "vitest";
import {
  decideResume,
  isClaudeSessionId,
  RUNTIME_CLAUDE_CODE,
  resolveRuntimeResume,
  resolveWorktreeIdentity,
  sessionRuntime,
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

// resolveWorktreeIdentity (#463): a legacy loophub/issue-<n> branch (worktree provisioned before
// the PR-id convention) keeps resolving to its issue-<n> path; anything else — including
// off-convention branches — resolves to the PR's own number, never a linked issue. Falling back to
// a linked issue for an off-convention branch (the pre-#463 behavior) is exactly what let two PRs
// on the same issue collide on one worktree, so that fallback is gone.
test("resolveWorktreeIdentity: a legacy loophub/issue-<n> branch resolves to the legacy scheme", () => {
  expect(resolveWorktreeIdentity("loophub/issue-7", 9)).toEqual({
    scheme: "legacy-issue",
    number: 7,
  });
});

test("resolveWorktreeIdentity: an off-convention branch resolves to the PR's own number", () => {
  expect(resolveWorktreeIdentity("feature-x", 9)).toEqual({
    scheme: "pr",
    number: 9,
  });
  expect(resolveWorktreeIdentity(null, 9)).toEqual({ scheme: "pr", number: 9 });
});

test("resolveWorktreeIdentity: a current loophub/pr-<n> branch resolves to the PR scheme", () => {
  expect(resolveWorktreeIdentity("loophub/pr-9", 9)).toEqual({
    scheme: "pr",
    number: 9,
  });
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

// sessionRuntime: explicit runtime wins; a runtime-less lh-dev row is the backward-compat
// claude-code case; any other runtime-less row is unknown provenance (null).
test("sessionRuntime prefers the explicit runtime column", () => {
  expect(sessionRuntime({ runtime: "claude-code", agent: "lh-dev" })).toBe(
    RUNTIME_CLAUDE_CODE,
  );
  // an explicit (even if unsupported) runtime is returned verbatim, not overridden by the fallback
  expect(sessionRuntime({ runtime: "codex", agent: "lh-dev" })).toBe("codex");
});

test("sessionRuntime falls back to claude-code for a pre-runtime lh-dev session", () => {
  expect(sessionRuntime({ runtime: null, agent: "lh-dev" })).toBe(
    RUNTIME_CLAUDE_CODE,
  );
  expect(sessionRuntime({ agent: "lh-dev" })).toBe(RUNTIME_CLAUDE_CODE);
});

test("sessionRuntime is null for a runtime-less non-lh-dev session and for no row", () => {
  expect(sessionRuntime({ runtime: null, agent: "impl-bot" })).toBeNull();
  expect(sessionRuntime(null)).toBeNull();
  expect(sessionRuntime(undefined)).toBeNull();
});

// resolveRuntimeResume: claude-code resumes only a UUID id; null runtime is no-session; any other
// runtime is unknown-runtime so the CLI can explain it.
test("resolveRuntimeResume resumes a claude-code session with a UUID id", () => {
  const uuid = "d8a43602-f469-4b03-8fa8-0af5200f22b3";
  expect(resolveRuntimeResume(RUNTIME_CLAUDE_CODE, uuid)).toEqual({
    ok: true,
    runtime: RUNTIME_CLAUDE_CODE,
    sessionId: uuid,
  });
});

test("resolveRuntimeResume rejects a claude-code session with a non-UUID id as no-session", () => {
  expect(
    resolveRuntimeResume(RUNTIME_CLAUDE_CODE, "--dangerously-skip-permissions"),
  ).toEqual({ ok: false, reason: "no-session" });
  expect(resolveRuntimeResume(RUNTIME_CLAUDE_CODE, null)).toEqual({
    ok: false,
    reason: "no-session",
  });
});

test("resolveRuntimeResume reports no-session for a null runtime", () => {
  expect(
    resolveRuntimeResume(null, "d8a43602-f469-4b03-8fa8-0af5200f22b3"),
  ).toEqual({ ok: false, reason: "no-session" });
});

test("resolveRuntimeResume reports unknown-runtime for an unsupported runtime", () => {
  expect(
    resolveRuntimeResume("codex", "d8a43602-f469-4b03-8fa8-0af5200f22b3"),
  ).toEqual({ ok: false, reason: "unknown-runtime" });
});
