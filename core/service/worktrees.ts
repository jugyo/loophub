import {
  canonicalPath,
  classifyWorktree,
  existsSync,
  issueNumberFromBranch,
  join,
  lstatSync,
  porcelainIsDirty,
  prNumberFromBranch,
  repoOr404,
  rmSync,
  S,
  worktreeList,
  worktreePrune,
  worktreeRemove,
  worktreeStatus,
} from "./shared.ts";

// ===== worktree housekeeping =====
// Batch GC of stale `lh build` worktrees: the current `loophub/pr-<n>` convention (#463) and the
// legacy pre-#463 `loophub/issue-<n>` convention (still recognized so a worktree provisioned
// before the migration is not orphaned). The orchestration — scanning git worktrees, resolving
// each one's issue/PR state, and the destructive removal — lives here so the CLI stays a thin
// presenter and the logic is unit-testable. Pure decisioning (clean-tree guard, keep/remove/skip
// classification) stays in worktree-prune.ts.

// The number encoded in a LoopHub-managed branch, current or legacy convention — used purely as
// a lookup key into `issues` (which numbers issues and pulls in one sequence per repo), so it does
// not matter here whether it names an issue or a PR row.
function worktreeNumberFromBranch(branch: string | null): number | null {
  return issueNumberFromBranch(branch) ?? prNumberFromBranch(branch);
}

export interface WorktreePlanEntry {
  repo: string; // owner/name
  repoPath: string; // primary checkout (shared .git)
  path: string; // worktree directory
  branch: string;
  issue: number; // the number encoded in the branch (issue or PR, whichever convention applies)
  action: "remove" | "keep" | "skip";
  reason: string;
}

export const worktrees = {
  // Scan LoopHub worktrees across one repo (`repo`) or every registered repo, resolve each
  // worktree's issue/PR state from the DB, and classify. `cwd` is the caller's working dir (the
  // running checkout is never a removal candidate); it is canonicalized here so callers can pass
  // a raw `process.cwd()`.
  async plan(opts: {
    repo?: string | null;
    cwd: string;
    force?: boolean;
  }): Promise<WorktreePlanEntry[]> {
    const repoRows = opts.repo ? [repoOr404(opts.repo)] : S.listRepos("all");
    const cwd = canonicalPath(opts.cwd);
    const entries: WorktreePlanEntry[] = [];
    for (const r of repoRows) {
      for (const wt of await worktreeList(r.local_path)) {
        const n = worktreeNumberFromBranch(wt.branch);
        if (n == null) continue; // primary checkout / off-convention worktrees are not ours

        let issueState: "open" | "closed" | null = null;
        let prMerged = false;
        let prState: "open" | "closed" | null = null;
        // Done-ness comes from the row's own state. A legacy worktree's branch names its issue
        // (row.kind === "issue"), so merged-ness comes from its linked PR; the current #463
        // convention names the worktree after the PR itself (row.kind === "pull"), so its own
        // merged/state apply directly.
        const row = S.getIssue(r.id, n);
        if (row) {
          issueState = row.state;
          if (row.kind === "issue") {
            const pr = S.linkedPullForIssue(row.id);
            if (pr) {
              prMerged = !!pr.merged;
              prState = pr.state;
            }
          } else {
            const pull = S.getPull(row.id);
            prMerged = !!pull?.merged;
            prState = row.state;
          }
        }

        const st = await worktreeStatus(wt.path);
        const dirty = st.code !== 0 || porcelainIsDirty(st.stdout);
        const { action, reason } = classifyWorktree({
          isCwd: canonicalPath(wt.path) === cwd,
          dirty,
          force: opts.force,
          issueState,
          prMerged,
          prState,
        });
        entries.push({
          repo: r.full_name,
          repoPath: r.local_path,
          path: wt.path,
          branch: wt.branch ?? "",
          issue: n,
          action,
          reason,
        });
      }
    }
    return entries;
  },

  // Remove one worktree after re-asserting the safety invariants right before the destructive
  // call: it must still be a registered worktree on its `loophub/pr-<n>` (or legacy
  // `loophub/issue-<n>`) branch (state may have changed since plan()). The LoopHub-injected,
  // un-gitignored `.claude/` is dropped first (regenerated on the next `lh build`) so the
  // no-`--force` `git worktree remove` stays a real guard for any other change — but only when it
  // is a real directory, never a symlink.
  async remove(entry: {
    repoPath: string;
    path: string;
    issue: number;
    force?: boolean;
  }): Promise<{ removed: boolean; reason?: string }> {
    const fresh = await worktreeList(entry.repoPath);
    const match = fresh.find(
      (w) => canonicalPath(w.path) === canonicalPath(entry.path),
    );
    if (!match || worktreeNumberFromBranch(match.branch) !== entry.issue) {
      return {
        removed: false,
        reason: `no longer a loophub-managed worktree for #${entry.issue}`,
      };
    }
    const claudeDir = join(entry.path, ".claude");
    const claudeStat = existsSync(claudeDir) ? lstatSync(claudeDir) : null;
    if (claudeStat?.isDirectory() && !claudeStat.isSymbolicLink()) {
      rmSync(claudeDir, { recursive: true, force: true });
    }
    try {
      await worktreeRemove(entry.repoPath, entry.path, {
        force: entry.force,
      });
    } catch (e: any) {
      return {
        removed: false,
        reason: e?.message ?? "git worktree remove failed",
      };
    }
    return { removed: true };
  },

  // Run `git worktree prune` (tidy stale admin entries) for one repo or every registered repo.
  async tidy(repo?: string | null): Promise<void> {
    const repoRows = repo ? [repoOr404(repo)] : S.listRepos("all");
    for (const r of repoRows) await worktreePrune(r.local_path);
  },
};
