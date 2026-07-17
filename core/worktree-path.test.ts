import { describe, expect, test } from "vitest";
import {
  fullNameFromWorktreePath,
  legacyWorktreePath,
  pullNumberFromWorktreePath,
  worktreePath,
} from "./worktree-path.ts";

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

describe("fullNameFromWorktreePath", () => {
  test("recovers owner/name from a current pr-<n> worktree path", () => {
    const root = "/home/u/.loophub/worktrees";
    const path = worktreePath(root, "me/app", 12);
    expect(fullNameFromWorktreePath(root, path)).toBe("me/app");
  });

  test("recovers owner/name from a legacy issue-<n> worktree path", () => {
    const root = "/home/u/.loophub/worktrees";
    const path = legacyWorktreePath(root, "acme/widget", 7);
    expect(fullNameFromWorktreePath(root, path)).toBe("acme/widget");
  });

  test("returns null for the worktree root itself", () => {
    const root = "/home/u/.loophub/worktrees";
    expect(fullNameFromWorktreePath(root, root)).toBeNull();
  });

  test("returns null for a path outside the worktree root", () => {
    const root = "/home/u/.loophub/worktrees";
    expect(fullNameFromWorktreePath(root, "/home/u/ws/app")).toBeNull();
  });

  test("returns null for a nested path under a worktree leaf", () => {
    const root = "/home/u/.loophub/worktrees";
    const path = worktreePath(root, "me/app", 12);
    expect(fullNameFromWorktreePath(root, `${path}/src`)).toBeNull();
  });

  test("returns null for a non-convention leaf under owner/repo", () => {
    const root = "/home/u/.loophub/worktrees";
    expect(fullNameFromWorktreePath(root, `${root}/me/app/scratch`)).toBeNull();
  });
});
