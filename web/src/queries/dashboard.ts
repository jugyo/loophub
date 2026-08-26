// Query hooks for the repo dashboard (/r/:owner/:repo). Each section maps to one
// hook; the event invalidation map (../lib/event-keys.ts) keys off the same
// query-key factories so lists refetch on change.

import { useQuery } from "@tanstack/react-query";
import { getDashboardOverview } from "@/api/client";
import { queryKeys } from "./keys";

// --- cross-repo top page (/) ---
// Dashboard queries are keyed by their label filter. Event invalidation keys off
// the shared queryKeys.dashboard() prefix.

/** Recently created open issues across all active repos, newest first. */
export function useRecentOpenIssues() {
  return useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: () => getDashboardOverview(),
    select: (overview) => overview.issues,
  });
}

/** Grouped repositories and issue rows for the top-page dashboard. */
export function useDashboardOverview(labels: string[] = []) {
  return useQuery({
    queryKey: [...queryKeys.dashboard(), "overview", labels],
    queryFn: () => getDashboardOverview(labels),
  });
}

/** The cap on the recent-issues list, so the UI can note when it's reached. */
export function useRecentIssuesLimit() {
  return useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: () => getDashboardOverview(),
    select: (overview) => overview.recentIssuesLimit,
  });
}
