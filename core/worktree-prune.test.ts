import { expect, test } from "vitest";
import {
  autoPruneGraceElapsed,
  classifyWorktree,
  issueNumberFromBranch,
  porcelainIsDirty,
  prNumberFromBranch,
  WORKTREE_AUTO_PRUNE_GRACE_MS,
  worktreeDoneAt,
} from "./worktree-prune.ts";

test("issueNumberFromBranch matches only the legacy loophub/issue-<n> convention", () => {
  expect(issueNumberFromBranch("loophub/issue-95")).toBe(95);
  expect(issueNumberFromBranch("loophub/issue-1")).toBe(1);
  expect(issueNumberFromBranch("main")).toBeNull();
  expect(issueNumberFromBranch("loophub/issue-")).toBeNull();
  expect(issueNumberFromBranch("loophub/issue-12a")).toBeNull();
  expect(issueNumberFromBranch("feature/loophub/issue-3")).toBeNull();
  expect(issueNumberFromBranch("loophub/pr-95")).toBeNull();
  expect(issueNumberFromBranch(null)).toBeNull();
});

test("prNumberFromBranch matches only the current loophub/pr-<n> convention (#463)", () => {
  expect(prNumberFromBranch("loophub/pr-95")).toBe(95);
  expect(prNumberFromBranch("loophub/pr-1")).toBe(1);
  expect(prNumberFromBranch("main")).toBeNull();
  expect(prNumberFromBranch("loophub/pr-")).toBeNull();
  expect(prNumberFromBranch("loophub/pr-12a")).toBeNull();
  expect(prNumberFromBranch("feature/loophub/pr-3")).toBeNull();
  expect(prNumberFromBranch("loophub/issue-95")).toBeNull();
  expect(prNumberFromBranch(null)).toBeNull();
});

test("porcelainIsDirty ignores the injected .claude/ artifact but flags real changes", () => {
  expect(porcelainIsDirty("")).toBe(false);
  // .claude/ is mirrored into every worktree and not gitignored — must not count as dirty.
  expect(porcelainIsDirty("?? .claude/")).toBe(false);
  expect(porcelainIsDirty("?? .claude/settings.local.json")).toBe(false);
  // Real uncommitted/untracked work makes it dirty.
  expect(porcelainIsDirty(" M src/app.ts")).toBe(true);
  expect(porcelainIsDirty("?? new-file.txt")).toBe(true);
  expect(porcelainIsDirty("?? .claude/\n M src/app.ts")).toBe(true);
  // Malformed/short status line with no path must not be read as dirty.
  expect(porcelainIsDirty("?? ")).toBe(false);
  expect(porcelainIsDirty("??")).toBe(false);
});

test("classifyWorktree: cwd and dirty guards win over done-ness", () => {
  expect(
    classifyWorktree({
      isCwd: true,
      dirty: false,
      issueState: "closed",
      prMerged: true,
      prState: "open",
    }),
  ).toEqual({ action: "skip", reason: "current working directory" });

  expect(
    classifyWorktree({
      isCwd: false,
      dirty: true,
      issueState: "closed",
      prMerged: true,
      prState: "closed",
    }),
  ).toEqual({ action: "skip", reason: "uncommitted or untracked changes" });
});

test("classifyWorktree: force bypasses only the dirty guard", () => {
  expect(
    classifyWorktree({
      isCwd: false,
      dirty: true,
      force: true,
      issueState: "closed",
      prMerged: false,
      prState: null,
    }),
  ).toEqual({ action: "remove", reason: "issue closed" });

  expect(
    classifyWorktree({
      isCwd: true,
      dirty: true,
      force: true,
      issueState: "closed",
      prMerged: true,
      prState: "closed",
    }),
  ).toEqual({ action: "skip", reason: "current working directory" });
});

test("classifyWorktree: removal candidates are merged PR or closed issue", () => {
  expect(
    classifyWorktree({
      isCwd: false,
      dirty: false,
      issueState: "open",
      prMerged: true,
      prState: "closed",
    }),
  ).toEqual({ action: "remove", reason: "PR merged" });

  expect(
    classifyWorktree({
      isCwd: false,
      dirty: false,
      issueState: "closed",
      prMerged: false,
      prState: null,
    }),
  ).toEqual({ action: "remove", reason: "issue closed" });
});

test("classifyWorktree: keep open work and unknown issues", () => {
  expect(
    classifyWorktree({
      isCwd: false,
      dirty: false,
      issueState: "open",
      prMerged: false,
      prState: "open",
    }),
  ).toEqual({ action: "keep", reason: "issue open, PR not merged" });

  expect(
    classifyWorktree({
      isCwd: false,
      dirty: false,
      issueState: null,
      prMerged: false,
      prState: null,
    }),
  ).toEqual({ action: "keep", reason: "issue not found in LoopHub" });
});

test("worktreeDoneAt reads the merge timestamp first, then the close timestamp", () => {
  // A merged PR wins over the issue's own close timestamp, matching classifyWorktree.
  expect(
    worktreeDoneAt({
      prMerged: true,
      prMergedAt: "2026-07-20T00:00:00.000Z",
      issueState: "closed",
      issueClosedAt: "2026-07-21T00:00:00.000Z",
    }),
  ).toBe("2026-07-20T00:00:00.000Z");

  expect(
    worktreeDoneAt({
      prMerged: false,
      prMergedAt: null,
      issueState: "closed",
      issueClosedAt: "2026-07-21T00:00:00.000Z",
    }),
  ).toBe("2026-07-21T00:00:00.000Z");

  // Unfinished work, and a done row whose timestamp predates the closed_at column, have none.
  expect(
    worktreeDoneAt({
      prMerged: false,
      prMergedAt: null,
      issueState: "open",
      issueClosedAt: null,
    }),
  ).toBeNull();
  expect(
    worktreeDoneAt({
      prMerged: false,
      prMergedAt: null,
      issueState: null,
      issueClosedAt: null,
    }),
  ).toBeNull();
  expect(
    worktreeDoneAt({
      prMerged: true,
      prMergedAt: null,
      issueState: "closed",
      issueClosedAt: "2026-07-21T00:00:00.000Z",
    }),
  ).toBeNull();
});

test("autoPruneGraceElapsed holds a finished worktree for the full grace period", () => {
  expect(WORKTREE_AUTO_PRUNE_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  const doneAt = "2026-07-21T00:00:00.000Z";
  const doneMs = Date.parse(doneAt);

  // The boundary itself is eligible; one millisecond earlier is not.
  expect(
    autoPruneGraceElapsed(doneAt, doneMs + WORKTREE_AUTO_PRUNE_GRACE_MS),
  ).toBe(true);
  expect(
    autoPruneGraceElapsed(doneAt, doneMs + WORKTREE_AUTO_PRUNE_GRACE_MS - 1),
  ).toBe(false);
  expect(autoPruneGraceElapsed(doneAt, doneMs)).toBe(false);

  // A completion time we cannot confirm never expires, however old the worktree looks.
  expect(autoPruneGraceElapsed(null, doneMs + 10 * 24 * 60 * 60 * 1000)).toBe(
    false,
  );
  expect(
    autoPruneGraceElapsed("not-a-date", doneMs + 10 * 24 * 60 * 60 * 1000),
  ).toBe(false);

  // Callers may shorten the grace period (tests, future configuration).
  expect(autoPruneGraceElapsed(doneAt, doneMs + 1000, 1000)).toBe(true);
});
