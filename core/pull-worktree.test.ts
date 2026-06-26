import { describe, expect, it } from "vitest";
import type { GitResult } from "./git.ts";
import { pullWorktreeDirty } from "./pull-worktree.ts";

const ROOT = "/wt-root";
// Deterministic worktree dir for the lh-dev convention head below (issue 7).
const WT = "/wt-root/me/repo/issue-7";

function result(stdout: string, code = 0): GitResult {
  return { code, stdout, stderr: "" };
}

const baseInput = {
  fullName: "me/repo",
  headRef: "loophub/issue-7",
  linkedIssueNumber: 3,
  prNumber: 9,
  merged: false,
  state: "open",
};

describe("pullWorktreeDirty", () => {
  it("returns true on a real uncommitted change in the worktree", async () => {
    let statusedPath: string | null = null;
    const dirty = await pullWorktreeDirty(baseInput, {
      worktreeRootDir: ROOT,
      exists: (p) => p === WT,
      status: async (p) => {
        statusedPath = p;
        return result(" M core/foo.ts\n");
      },
    });
    expect(dirty).toBe(true);
    // Derived from the lh-dev branch convention, not the PR number.
    expect(statusedPath).toBe(WT);
  });

  it("returns false for a clean worktree", async () => {
    const dirty = await pullWorktreeDirty(baseInput, {
      worktreeRootDir: ROOT,
      exists: () => true,
      status: async () => result(""),
    });
    expect(dirty).toBe(false);
  });

  it("returns false when only injected .claude/ artifacts differ", async () => {
    const dirty = await pullWorktreeDirty(baseInput, {
      worktreeRootDir: ROOT,
      exists: () => true,
      status: async () => result("?? .claude/\n?? .claude/settings.json\n"),
    });
    expect(dirty).toBe(false);
  });

  it("returns false (and skips git) when the worktree directory is absent", async () => {
    let called = false;
    const dirty = await pullWorktreeDirty(baseInput, {
      worktreeRootDir: ROOT,
      exists: () => false,
      status: async () => {
        called = true;
        return result(" M x\n");
      },
    });
    expect(dirty).toBe(false);
    expect(called).toBe(false);
  });

  it("returns false (and skips git) for a merged PR", async () => {
    let called = false;
    const dirty = await pullWorktreeDirty(
      { ...baseInput, merged: true },
      {
        worktreeRootDir: ROOT,
        exists: () => true,
        status: async () => {
          called = true;
          return result(" M x\n");
        },
      },
    );
    expect(dirty).toBe(false);
    expect(called).toBe(false);
  });

  it("returns false (and skips git) for a closed PR", async () => {
    let called = false;
    const dirty = await pullWorktreeDirty(
      { ...baseInput, state: "closed" },
      {
        worktreeRootDir: ROOT,
        exists: () => true,
        status: async () => {
          called = true;
          return result(" M x\n");
        },
      },
    );
    expect(dirty).toBe(false);
    expect(called).toBe(false);
  });

  it("treats a failed git status as not-dirty", async () => {
    const dirty = await pullWorktreeDirty(baseInput, {
      worktreeRootDir: ROOT,
      exists: () => true,
      status: async () => result("", 128),
    });
    expect(dirty).toBe(false);
  });

  it("falls back to the linked issue number for an off-convention head", async () => {
    let statusedPath: string | null = null;
    await pullWorktreeDirty(
      { ...baseInput, headRef: "feature-x" },
      {
        worktreeRootDir: ROOT,
        exists: (p) => {
          statusedPath = p;
          return false;
        },
        status: async () => result(""),
      },
    );
    expect(statusedPath).toBe("/wt-root/me/repo/issue-3");
  });
});
