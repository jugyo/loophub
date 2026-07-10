// PEVR run display-state query hooks (#1008): the latest run linked to an issue / PR, shown on the
// issue and PR detail pages. Keyed per issue / PR; SSE-driven invalidation (pevr_run.* /
// pevr_step.* / pevr_artifact.* in lib/event-keys.ts) keeps the state fresh as the run advances.
// The query resolves to null when the issue / PR has no run.

import { useQuery } from "@tanstack/react-query";
import { getPevrRunStateForIssue, getPevrRunStateForPull } from "@/api/client";
import { queryKeys } from "./keys";

/** Latest PEVR run linked to an issue, or null. */
export function usePevrRunForIssue(
  owner: string,
  repo: string,
  number: number,
) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.pevrRunForIssue(full, number),
    queryFn: () => getPevrRunStateForIssue(full, number),
  });
}

/** Latest PEVR run linked to a PR, or null. */
export function usePevrRunForPull(owner: string, repo: string, number: number) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.pevrRunForPull(full, number),
    queryFn: () => getPevrRunStateForPull(full, number),
  });
}
