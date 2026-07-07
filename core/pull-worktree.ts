// Decide whether the lh-build worktree backing an open PR has real uncommitted work, for the
// "working" badge on PR list/detail. Orchestration is kept here (not inline in serialize.ts)
// so the guards are unit-testable with injected fs/git seams. Load is bounded: merged/closed
// PRs and PRs whose deterministic worktree directory is absent return false without touching
// git, and `git status` only runs for an open PR whose worktree actually exists. The injected
// `.claude/` artifact is filtered by porcelainIsDirty (shared with `lh worktree prune`).
import { existsSync } from "node:fs";
import { worktreeRoot } from "./config.ts";
import type { GitResult } from "./git.ts";
import { worktreeStatus } from "./git.ts";
import { resolveWorktreeIdentity } from "./resume.ts";
import { legacyWorktreePath, worktreePath } from "./worktree-path.ts";
import { porcelainIsDirty } from "./worktree-prune.ts";

export interface PullWorktreeDirtyInput {
  fullName: string; // repo "owner/name"
  headRef: string | null; // PR head branch (lh-build convention: loophub/pr-<n>, or legacy issue-<n>)
  prNumber: number; // worktree key when headRef is off-convention (#463: PR-id based)
  merged: boolean;
  state: string; // "open" | "closed"
}

// Seams default to the real fs/git/config so callers pass only the PR fields; tests inject
// deterministic substitutes to exercise the worktree-absent / clean / dirty / artifact-only
// branches without a real checkout.
export interface PullWorktreeDirtyDeps {
  worktreeRootDir?: string;
  exists?: (path: string) => boolean;
  status?: (path: string) => Promise<GitResult>;
}

export async function pullWorktreeDirty(
  input: PullWorktreeDirtyInput,
  deps: PullWorktreeDirtyDeps = {},
): Promise<boolean> {
  // merged/closed PRs are not active work — never inspect their worktree.
  if (input.merged || input.state !== "open") return false;

  const root = deps.worktreeRootDir ?? worktreeRoot();
  const identity = resolveWorktreeIdentity(input.headRef, input.prNumber);
  let path: string;
  try {
    path =
      identity.scheme === "legacy-issue"
        ? legacyWorktreePath(root, input.fullName, identity.number)
        : worktreePath(root, input.fullName, identity.number);
  } catch {
    return false; // crafted repo name → no worktree to inspect
  }

  const exists = deps.exists ?? existsSync;
  if (!exists(path)) return false; // no worktree → skip git entirely

  const status = deps.status ?? worktreeStatus;
  const r = await status(path);
  if (r.code !== 0) return false; // couldn't verify cleanliness → don't claim "working"
  return porcelainIsDirty(r.stdout);
}
