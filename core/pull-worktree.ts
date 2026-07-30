// Decide whether the worktree backing an open PR has real uncommitted work, for the
// "working" badge on PR list/detail. Orchestration is kept here (not inline in serialize.ts)
// so the guards are unit-testable with injected fs/git seams. Load is bounded: merged/closed
// PRs and PRs whose deterministic worktree directory is absent return false without touching
// git, and `git status` only runs for an open PR whose worktree actually exists. The injected
// `.claude/` artifact is filtered by porcelainIsDirty (shared with `lh worktree prune`).
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { worktreeRoot } from "./config.ts";
import type { GitResult } from "./git.ts";
import { worktreeStatus } from "./git.ts";
import { resolveWorktreeIdentity } from "./resume.ts";
import {
  assertSafeRepoSegments,
  legacyWorktreePath,
  worktreePath,
} from "./worktree-path.ts";
import { porcelainIsDirty } from "./worktree-prune.ts";

export interface PullWorktreeDirtyInput {
  fullName: string; // repo "owner/name"
  headRef: string | null; // PR head branch (worktree convention: loophub/pr-<n>, or legacy issue-<n>)
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

type PullWorktreePathInput = Pick<
  PullWorktreeDirtyInput,
  "fullName" | "headRef" | "prNumber"
>;

function resolvePullWorktreePath(
  input: PullWorktreePathInput,
  root: string,
): string | null {
  try {
    assertSafeRepoSegments(input.fullName, "worktree path");
  } catch {
    return null;
  }

  const identity = resolveWorktreeIdentity(input.headRef, input.prNumber);
  const absoluteRoot = resolve(root);
  return identity.scheme === "legacy-issue"
    ? legacyWorktreePath(absoluteRoot, input.fullName, identity.number)
    : worktreePath(absoluteRoot, input.fullName, identity.number);
}

function isMissingDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function existingPullWorktreePath(
  input: PullWorktreePathInput,
  deps: {
    worktreeRootDir?: string;
    isDirectory?: (path: string) => boolean;
  } = {},
): string | null {
  const root = deps.worktreeRootDir ?? worktreeRoot();
  const path = resolvePullWorktreePath(input, root);
  if (!path) return null;

  const isDirectory =
    deps.isDirectory ?? ((candidate) => statSync(candidate).isDirectory());
  try {
    return isDirectory(path) ? path : null;
  } catch (error) {
    if (isMissingDirectoryError(error)) return null;
    throw error;
  }
}

export async function pullWorktreeDirty(
  input: PullWorktreeDirtyInput,
  deps: PullWorktreeDirtyDeps = {},
): Promise<boolean> {
  // merged/closed PRs are not active work — never inspect their worktree.
  if (input.merged || input.state !== "open") return false;

  const path = resolvePullWorktreePath(
    input,
    deps.worktreeRootDir ?? worktreeRoot(),
  );
  if (!path) return false; // crafted repo name → no worktree to inspect

  const exists = deps.exists ?? existsSync;
  if (!exists(path)) return false; // no worktree → skip git entirely

  const status = deps.status ?? worktreeStatus;
  const r = await status(path);
  if (r.code !== 0) return false; // couldn't verify cleanliness → don't claim "working"
  return porcelainIsDirty(r.stdout);
}
