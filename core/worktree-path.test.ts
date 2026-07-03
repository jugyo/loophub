import { describe, expect, test } from "vitest";
import { pullNumberFromWorktreePath, worktreePath } from "./worktree-path.ts";

describe("pullNumberFromWorktreePath", () => {
  test("recovers the PR number from a worktreePath() output", () => {
    const root = "/home/u/.loophub/worktrees";
    const path = worktreePath(root, "me/app", 12);
    expect(pullNumberFromWorktreePath(root, "me/app", path)).toBe(12);
  });

  test("returns null for the repo root (no pr-<n> segment)", () => {
    expect(
      pullNumberFromWorktreePath(
        "/home/u/.loophub/worktrees",
        "me/app",
        "/home/u/ws/app",
      ),
    ).toBeNull();
  });

  test("returns null for the legacy issue-<n> convention", () => {
    const root = "/home/u/.loophub/worktrees";
    expect(
      pullNumberFromWorktreePath(root, "me/app", `${root}/me/app/issue-12`),
    ).toBeNull();
  });

  test("returns null for a path under a different repo", () => {
    const root = "/home/u/.loophub/worktrees";
    expect(
      pullNumberFromWorktreePath(root, "me/app", `${root}/me/other/pr-12`),
    ).toBeNull();
  });

  test("returns null for a pr-<n> segment nested one level too deep", () => {
    const root = "/home/u/.loophub/worktrees";
    expect(
      pullNumberFromWorktreePath(root, "me/app", `${root}/me/app/x/pr-12`),
    ).toBeNull();
  });
});
