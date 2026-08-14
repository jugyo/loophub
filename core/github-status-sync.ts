import {
  GITHUB_PR_STATUS_TTL_MS,
  type GithubPrStatusDeps,
  realGithubPrStatusDeps,
} from "./github.ts";
import * as S from "./store.ts";

export interface GithubPrStatusSyncResult {
  checked: number;
  refreshed: number;
  failures: number;
}

// Refresh the cache used by pulls/githubStatus for active pull-detail targets. A failure is kept at
// the target boundary: the next target still gets a chance, and the old cache remains available to
// the RPC's stale-cache fallback.
export async function syncGithubPrStatus(
  deps: GithubPrStatusDeps = realGithubPrStatusDeps,
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
      S.saveGithubPullStatus(link.issue_id, JSON.stringify(status));
      result.refreshed++;
    } catch {
      result.failures++;
    }
  }
  return result;
}
