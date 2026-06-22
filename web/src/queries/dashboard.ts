// Query hooks for the repo dashboard (/r/:owner/:repo). Each section maps to one
// hook; the SSE invalidation map (../lib/event-keys.ts) keys off the same
// query-key factories so lists refetch on change.

import { useQuery } from "@tanstack/react-query";
import { getDashboardOverview, listIssues, listPulls } from "@/api/client";
import { queryKeys } from "./keys";

/** Max items per dashboard section (DESIGN.md: each list ~20, then "see all"). */
export const SECTION_LIMIT = 20;

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** Open issues (excludes PRs) for the dashboard's Open Issues section, newest update first. */
export function useOpenIssues(owner: string, repo: string) {
  return useQuery({
    queryKey: queryKeys.issues(full(owner, repo)),
    queryFn: () =>
      listIssues(owner, repo, `state=open&kind=issue&per_page=${SECTION_LIMIT}`),
  });
}

/** Open pull requests for the dashboard's Open PRs section. */
export function useOpenPulls(owner: string, repo: string) {
  return useQuery({
    queryKey: queryKeys.pulls(full(owner, repo)),
    queryFn: () =>
      listPulls(owner, repo, `state=open&per_page=${SECTION_LIMIT}`),
  });
}

// --- cross-repo top page (/) ---
// Both hooks share one query key, so the overview is fetched once and each hook
// selects its slice. SSE invalidation keys off queryKeys.dashboard().

/** In-progress (agent-assigned) issues across all active repos. */
export function useInProgressIssues() {
  return useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: getDashboardOverview,
    select: (overview) => overview.issues,
  });
}

/** Open, unmerged pull requests across all active repos. */
export function useUnmergedPulls() {
  return useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: getDashboardOverview,
    select: (overview) => overview.pulls,
  });
}
