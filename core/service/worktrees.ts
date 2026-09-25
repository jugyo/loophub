import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  worktreeList,
  worktreePrune,
  worktreeRemove,
  worktreeStatus,
} from "../git.ts";
import * as S from "../store.ts";
import {
  autoPruneGraceElapsed,
  classifyWorktree,
  issueNumberFromBranch,
  porcelainIsDirty,
  WORKTREE_AUTO_PRUNE_GRACE_MS,
  worktreeDoneAt,
} from "../worktree-prune.ts";
import { canonicalPath, repoOr404 } from "./shared.ts";

// ===== worktree housekeeping =====
// Batch GC of LoopHub worktrees. PR worktrees are identified from the DB's head_ref rather than
// by decoding a branch naming convention. The pre-#463 issue branch remains as a fallback only
// when no PR row claims that branch.
function pullByHeadRef(
  pulls: S.PullWorktreeRow[],
): Map<string, S.PullWorktreeRow | null> {
  const byHead = new Map<string, S.PullWorktreeRow | null>();
  for (const pull of pulls) {
    byHead.set(pull.head_ref, byHead.has(pull.head_ref) ? null : pull);
  }
  return byHead;
}

function worktreeNumber(
  branch: string | null,
  pullsByHead: Map<string, S.PullWorktreeRow | null>,
): number | null {
  if (!branch) return null;
  if (pullsByHead.has(branch)) return pullsByHead.get(branch)?.number ?? null;
  return issueNumberFromBranch(branch);
}

export interface WorktreePlanEntry {
  repo: string; // owner/name
  repoPath: string; // primary checkout (shared .git)
  path: string; // worktree directory
  branch: string;
  issue: number; // the matched PR number, or the issue number for a legacy issue worktree
  action: "remove" | "keep" | "skip";
  reason: string;
  doneAt: string | null; // merge/close timestamp behind a "remove" verdict (see worktreeDoneAt)
}

export interface WorktreeRemoveInput {
  repo: string;
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
  pullsByHead: Map<string, S.PullWorktreeRow | null>,
): Promise<WorktreeRemoveResult> {
  const match = fresh.find(
    (w) => canonicalPath(w.path) === canonicalPath(entry.path),
  );
  if (!match || worktreeNumber(match.branch, pullsByHead) !== entry.issue) {
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
    const repo = repoOr404(group[0].entry.repo);
    const pullsByHead = pullByHeadRef(S.pullWorktrees(repo.id));
    for (const { entry, index } of group) {
      results[index] = await removeVerifiedWorktree(entry, fresh, pullsByHead);
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
    const pullsByHead = pullByHeadRef(S.pullWorktrees(r.id));
    for (const wt of await worktreeList(r.local_path)) {
      const n = worktreeNumber(wt.branch, pullsByHead);
      if (n == null) continue; // primary checkout, unmatched, or ambiguous worktrees are not ours

      let issueState: "open" | "closed" | null = null;
      let issueClosedAt: string | null = null;
      let prMerged = false;
      let prMergedAt: string | null = null;
      let prState: "open" | "closed" | null = null;
      const pull = wt.branch ? pullsByHead.get(wt.branch) : undefined;
      if (pull) {
        issueState = pull.state;
        issueClosedAt = pull.closed_at;
        prMerged = !!pull.merged;
        prMergedAt = pull.merged_at;
        prState = pull.state;
      } else {
        // A branch not claimed by a PR may still be a pre-#463 issue worktree.
        const row = S.getIssue(r.id, n);
        if (row) {
          issueState = row.state;
          issueClosedAt = row.closed_at;
          const linkedPull = S.linkedPullForIssue(row.id);
          if (linkedPull) {
            prMerged = !!linkedPull.merged;
            prMergedAt = linkedPull.merged_at;
            prState = linkedPull.state;
          }
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
