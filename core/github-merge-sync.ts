import { db } from "./db.ts";
import type { GithubMergeStatusDeps } from "./github.ts";
import * as S from "./store.ts";

// #800: check one linked PR's merge status on GitHub, record a detected merge into github_pulls, and
// emit pull_request.github_merged. Deliberately does not touch the loophub PR's own state/merged
// columns; the emitted event drives the user-facing Notification Center prompt instead. A `gh`
// failure (auth/network/deleted PR) throws to the caller, which reports it for this PR and retries
// on the next tick.
export async function syncGithubPullMerge(
  link: S.GithubSyncRow,
  deps: GithubMergeStatusDeps,
): Promise<S.EventRow | null> {
  const status = await deps.fetchMergeStatus(link.local_path, link.url);
  if (!status.merged) return null;
  // mergedAt should always be present once state is MERGED; a synthetic fallback only guards
  // against a malformed/unexpected gh response so a real detection is never silently dropped.
  const mergedAt = status.mergedAt ?? new Date().toISOString();
  // The `gh` call is done; the recorded merge and the event it fires commit together. Recording it
  // alone would make the merge check skip this link, so a lost event means the Notification Center
  // prompt is never shown for this PR.
  return db.transaction(() => {
    // A manual sync and the periodic one can both see the merge; only the first records it.
    if (S.getGithubPull(link.issue_id)?.github_merged) return null;
    S.setGithubMerged(link.issue_id, mergedAt);
    return S.emitEvent(
      link.repo_id,
      "pull_request.github_merged",
      status.mergedByLogin ?? "lh-worker",
      {
        number: link.number,
        github_number: link.github_number,
        github_merged_at: mergedAt,
      },
    );
  });
}
