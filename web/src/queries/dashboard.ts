// Query hooks for the repo dashboard (/r/:owner/:repo). Each section maps to one
// hook; the SSE invalidation map (../lib/event-keys.ts) keys off the same
// query-key factories so lists refetch on change.

import { useQuery } from "@tanstack/react-query";
import { getDashboardOverview, listIssues } from "@/api/client";
import { queryKeys } from "./keys";

/** Max items per dashboard section (DESIGN.md § Dashboard sections: each list ~20, then "see all"). */
export const SECTION_LIMIT = 20;

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** Open issues (excludes PRs) for the dashboard's Open Issues section, newest update first. */
export function useOpenIssues(owner: string, repo: string) {
  return useQuery({
    queryKey: queryKeys.issues(full(owner, repo)),
    queryFn: () =>
      listIssues(
        owner,
        repo,
        `state=open&kind=issue&per_page=${SECTION_LIMIT}`,
      ),
  });
}

// --- cross-repo top page (/) ---
// Both hooks share one query key, so the overview is fetched once and each hook
// selects its slice. SSE invalidation keys off queryKeys.dashboard().

/** Recently created open issues across all active repos, newest first. */
export function useRecentOpenIssues() {
  return useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: getDashboardOverview,
    select: (overview) => overview.issues,
  });
}

/** The cap on the recent-issues list, so the UI can note when it's reached. */
export function useRecentIssuesLimit() {
  return useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: getDashboardOverview,
    select: (overview) => overview.recentIssuesLimit,
  });
}
