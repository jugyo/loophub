import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitResult } from "./git.ts";
import {
  existingPullWorktreePath,
  pullWorktreeDirty,
} from "./pull-worktree.ts";

const ROOT = "/wt-root";
// Deterministic worktree dir for the lh-build convention head below (PR 9, #463).
const WT = "/wt-root/me/repo/pr-9";

function result(stdout: string, code = 0): GitResult {
  return { code, stdout, stderr: "" };
}

const baseInput = {
  fullName: "me/repo",
  headRef: "loophub/pr-9",
  prNumber: 9,
  merged: false,
  state: "open",
};

describe("existingPullWorktreePath", () => {
  it("returns an absolute path when the configured root is relative", () => {
    const expected = resolve("worktrees/me/repo/pr-9");
    expect(
      existingPullWorktreePath(baseInput, {
        worktreeRootDir: "worktrees",
        isDirectory: (path) => path === expected,
      }),
    ).toBe(expected);
  });

  it("preserves an absolute configured root", () => {
    expect(
      existingPullWorktreePath(baseInput, {
        worktreeRootDir: ROOT,
        isDirectory: (path) => path === WT,
      }),
    ).toBe(WT);
  });

  it.each([
    "ENOENT",
    "ENOTDIR",
  ])("returns null when the worktree lookup fails with %s", (code) => {
    expect(
      existingPullWorktreePath(baseInput, {
        worktreeRootDir: ROOT,
        isDirectory: () => {
          throw Object.assign(new Error(code), { code });
        },
      }),
    ).toBeNull();
  });

  it("propagates unexpected filesystem failures", () => {
    const error = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    expect(() =>
      existingPullWorktreePath(baseInput, {
        worktreeRootDir: ROOT,
        isDirectory: () => {
          throw error;
        },
      }),
    ).toThrow(error);
  });

  it("returns null for an unsafe repository name without touching the filesystem", () => {
    let called = false;
    expect(
      existingPullWorktreePath(
        { ...baseInput, fullName: "../repo" },
        {
          worktreeRootDir: ROOT,
          isDirectory: () => {
            called = true;
            return true;
          },
        },
      ),
    ).toBeNull();
    expect(called).toBe(false);
  });
});

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
    // Derived from the PR number (#463: PR-id-based worktree convention).
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

  it("falls back to the PR number for an off-convention head", async () => {
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
    expect(statusedPath).toBe("/wt-root/me/repo/pr-9");
  });

  it("recognizes a legacy loophub/issue-<n> head from before #463", async () => {
    let statusedPath: string | null = null;
    await pullWorktreeDirty(
      { ...baseInput, headRef: "loophub/issue-3" },
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
