import {
  autoPruneGraceElapsed,
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
  WORKTREE_AUTO_PRUNE_GRACE_MS,
  worktreeDoneAt,
  worktreeList,
  worktreePrune,
  worktreeRemove,
  worktreeStatus,
} from "./shared.ts";

// ===== worktree housekeeping =====
// Batch GC of stale LoopHub worktrees: the current `loophub/pr-<n>` convention (#463) and the
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
  doneAt: string | null; // merge/close timestamp behind a "remove" verdict (see worktreeDoneAt)
}

export interface WorktreeRemoveInput {
  repoPath: string;
  path: string;
  issue: number;
  force?: boolean;
}

export interface WorktreeRemoveResult {
  removed: boolean;
  reason?: string;
}

async function removeVerifiedWorktree(
  entry: WorktreeRemoveInput,
  fresh: Awaited<ReturnType<typeof worktreeList>>,
): Promise<WorktreeRemoveResult> {
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
}

async function removeMany(
  entries: WorktreeRemoveInput[],
): Promise<WorktreeRemoveResult[]> {
  const byRepo = new Map<
    string,
    Array<{ entry: WorktreeRemoveInput; index: number }>
  >();
  entries.forEach((entry, index) => {
    const group = byRepo.get(entry.repoPath) ?? [];
    group.push({ entry, index });
    byRepo.set(entry.repoPath, group);
  });

  const results = new Array<WorktreeRemoveResult>(entries.length);
  for (const [repoPath, group] of byRepo) {
    const fresh = await worktreeList(repoPath);
    for (const { entry, index } of group) {
      results[index] = await removeVerifiedWorktree(entry, fresh);
    }
  }
  return results;
}

// Scan LoopHub worktrees across one repo (`repo`) or every registered repo, resolve each
// worktree's issue/PR state from the DB, and classify. `cwd` is the caller's working dir (the
// running checkout is never a removal candidate); it is canonicalized here so callers can pass
// a raw `process.cwd()`.
async function plan(opts: {
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
      let issueClosedAt: string | null = null;
      let prMerged = false;
      let prMergedAt: string | null = null;
      let prState: "open" | "closed" | null = null;
      // Done-ness comes from the row's own state. A legacy worktree's branch names its issue
      // (row.kind === "issue"), so merged-ness comes from its linked PR; the current #463
      // convention names the worktree after the PR itself (row.kind === "pull"), so its own
      // merged/state apply directly.
      const row = S.getIssue(r.id, n);
      if (row) {
        issueState = row.state;
        issueClosedAt = row.closed_at;
        if (row.kind === "issue") {
          const pr = S.linkedPullForIssue(row.id);
          if (pr) {
            prMerged = !!pr.merged;
            prMergedAt = pr.merged_at;
            prState = pr.state;
          }
        } else {
          const pull = S.getPull(row.id);
          prMerged = !!pull?.merged;
          prMergedAt = pull?.merged_at ?? null;
          prState = row.state;
        }
      }

      const isCwd = canonicalPath(wt.path) === cwd;
      let dirty = false;
      if (!opts.force && !isCwd) {
        const st = await worktreeStatus(wt.path);
        dirty = st.code !== 0 || porcelainIsDirty(st.stdout);
      }
      const { action, reason } = classifyWorktree({
        isCwd,
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
        doneAt: worktreeDoneAt({
          prMerged,
          prMergedAt,
          issueState,
          issueClosedAt,
        }),
      });
    }
  }
  return entries;
}

export interface WorktreeAutoPruneFailure {
  repo: string; // owner/name
  path: string; // worktree directory
  reason: string;
}

export interface WorktreeAutoPruneResult {
  scanned: number; // LoopHub-managed worktrees seen across every registered repo
  candidates: number; // finished worktrees past the grace period
  removed: number;
  failed: WorktreeAutoPruneFailure[];
}

// Unattended GC of LoopHub worktrees whose work finished at least `graceMs` ago (#1837). Reuses
// the same scan/classification and the same pre-removal re-verification as `lh worktree prune`;
// the only extra condition is the confirmed completion timestamp. `force` is on because these are
// finished attempts a human already had a full day to rescue, and it also keeps the scan to one
// `git worktree list` per repo instead of a `git status` per worktree.
async function autoPrune(
  opts: { cwd?: string; nowMs?: number; graceMs?: number } = {},
): Promise<WorktreeAutoPruneResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const graceMs = opts.graceMs ?? WORKTREE_AUTO_PRUNE_GRACE_MS;
  const entries = await plan({ cwd: opts.cwd ?? process.cwd(), force: true });
  const candidates = entries.filter(
    (e) =>
      e.action === "remove" && autoPruneGraceElapsed(e.doneAt, nowMs, graceMs),
  );
  const results = await removeMany(
    candidates.map((entry) => ({ ...entry, force: true })),
  );
  const failed: WorktreeAutoPruneFailure[] = [];
  let removed = 0;
  for (const [index, entry] of candidates.entries()) {
    const result = results[index];
    if (result.removed) removed++;
    else
      failed.push({
        repo: entry.repo,
        path: entry.path,
        reason: result.reason ?? "removal failed",
      });
  }
  return {
    scanned: entries.length,
    candidates: candidates.length,
    removed,
    failed,
  };
}

export const worktrees = {
  plan,

  // Re-assert the managed-worktree invariant from one fresh list per repository immediately
  // before a batch removal. This preserves the safety check without repeating the same expensive
  // `git worktree list` for every candidate. The LoopHub-injected, un-gitignored `.claude/` is
  // dropped first (regenerated on the next provision) so no-force removal remains a guard for any
  // other change; symlinks are never followed.
  removeMany,

  autoPrune,

  async remove(entry: WorktreeRemoveInput): Promise<WorktreeRemoveResult> {
    return (await removeMany([entry]))[0];
  },

  // Run `git worktree prune` (tidy stale admin entries) for one repo or every registered repo.
  async tidy(repo?: string | null): Promise<void> {
    const repoRows = repo ? [repoOr404(repo)] : S.listRepos("all");
    for (const r of repoRows) await worktreePrune(r.local_path);
  },
};
