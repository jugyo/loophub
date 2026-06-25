import { expect, test } from "vitest";
import {
  classifyWorktree,
  issueNumberFromBranch,
  porcelainIsDirty,
} from "./worktree-prune.ts";

test("issueNumberFromBranch matches only the loophub/issue-<n> convention", () => {
  expect(issueNumberFromBranch("loophub/issue-95")).toBe(95);
  expect(issueNumberFromBranch("loophub/issue-1")).toBe(1);
  expect(issueNumberFromBranch("main")).toBeNull();
  expect(issueNumberFromBranch("loophub/issue-")).toBeNull();
  expect(issueNumberFromBranch("loophub/issue-12a")).toBeNull();
  expect(issueNumberFromBranch("feature/loophub/issue-3")).toBeNull();
  expect(issueNumberFromBranch(null)).toBeNull();
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
