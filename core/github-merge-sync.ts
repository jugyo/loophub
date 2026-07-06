import {
  type GithubMergeStatusDeps,
  realGithubMergeStatusDeps,
} from "./github.ts";
import * as S from "./store.ts";

// #800: poll GitHub for the merge status of every exported-but-not-yet-known-merged PR
// (S.unmergedGithubPullLinks), record a detected merge into github_pulls, and emit
// pull_request.github_merged — mirrors watcher.ts's sweepPullUpdates for the analogous
// local-push-detection sweep. Deliberately does not touch the loophub PR's own state/merged
// columns (recording only; flow integration is a separate, later issue). A `gh` failure on one
// link (auth/network/deleted PR) is skipped rather than thrown, so it doesn't block the rest of
// the sweep — it will simply be retried on the next tick.
export async function syncGithubMergeStatus(
  deps: GithubMergeStatusDeps = realGithubMergeStatusDeps,
): Promise<S.EventRow[]> {
  const emitted: S.EventRow[] = [];
  for (const link of S.unmergedGithubPullLinks()) {
    let status: Awaited<ReturnType<GithubMergeStatusDeps["fetchMergeStatus"]>>;
    try {
      status = await deps.fetchMergeStatus(link.local_path, link.url);
    } catch {
      continue;
    }
    if (!status.merged) continue;
    // mergedAt should always be present once state is MERGED; a synthetic fallback only guards
    // against a malformed/unexpected gh response so a real detection is never silently dropped.
    const mergedAt = status.mergedAt ?? new Date().toISOString();
    S.setGithubMerged(link.issue_id, mergedAt);
    emitted.push(
      S.emitEvent(
        link.repo_id,
        "pull_request.github_merged",
        status.mergedByLogin ?? "lh-worker",
        {
          number: link.number,
          github_number: link.github_number,
          github_merged_at: mergedAt,
        },
      ),
    );
  }
  return emitted;
}
