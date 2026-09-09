import { fetchRemote } from "./git.ts";
import {
  GITHUB_PR_STATUS_TTL_MS,
  type GithubPrStatusDeps,
  realGithubPrStatusDeps,
} from "./github.ts";
import { sweepPullConflicts } from "./pull-conflict-events.ts";
import * as S from "./store.ts";

export interface GithubPrStatusSyncResult {
  checked: number;
  refreshed: number;
  failures: number;
}

export interface GithubPrStatusSyncDeps extends GithubPrStatusDeps {
  fetchOrigin?: typeof fetchRemote;
}

const realGithubPrStatusSyncDeps: GithubPrStatusSyncDeps = {
  ...realGithubPrStatusDeps,
  fetchOrigin: fetchRemote,
};

// Refresh the cache used by pulls/githubStatus for active pull-detail targets. A failure is kept at
// the target boundary: the next target still gets a chance, and the old cache remains available to
// the RPC's stale-cache fallback.
export async function syncGithubPrStatus(
  deps: GithubPrStatusSyncDeps = realGithubPrStatusSyncDeps,
): Promise<GithubPrStatusSyncResult> {
  const result: GithubPrStatusSyncResult = {
    checked: 0,
    refreshed: 0,
    failures: 0,
  };
  for (const link of S.githubPrStatusSyncRows()) {
    result.checked++;
    const cached = S.getGithubPullStatus(link.issue_id);
    if (
      cached &&
      Date.now() - Date.parse(cached.synced_at) < GITHUB_PR_STATUS_TTL_MS
    ) {
      continue;
    }
    try {
      const status = await deps.fetchStatus(link.local_path, link.url);
      // GitHub evaluates the remote PR refs, while the local conflict sweep compares the checkout's
      // refs. Refresh origin before projecting a GitHub conflict into the local resolution path so
      // the executor sees the base revision that produced the remote result.
      if (status.mergeable === "conflicting") {
        const fetched = await (deps.fetchOrigin ?? fetchRemote)(
          link.local_path,
          "origin",
        );
        // The GitHub observation is still authoritative when the local refresh fails. Keep the
        // failure visible in the sweep result, but do not discard the status or its conflict edge.
        if (fetched.code !== 0) result.failures++;
      }
      await sweepPullConflicts({
        issueId: link.issue_id,
        githubStatus: status,
      });
      result.refreshed++;
    } catch {
      result.failures++;
    }
  }
  return result;
}
