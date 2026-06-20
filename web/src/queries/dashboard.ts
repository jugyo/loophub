// Query hooks for the repo dashboard (/r/:owner/:repo). Each section maps to one
// hook; the SSE invalidation map (../lib/event-keys.ts) keys off the same
// query-key factories so lists refetch on change.

import { useQuery } from "@tanstack/react-query";
import { listIssues, listPulls } from "@/api/client";
import { queryKeys } from "./keys";

/** Max items per dashboard section (DESIGN.md: each list ~20, then "see all"). */
export const SECTION_LIMIT = 20;

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** Open issues (excludes PRs) for the dashboard's Open Issues section. */
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
