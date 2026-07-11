// Workflow run display-state query hooks (#1008): the latest run linked to an issue / PR, shown on the
// issue and PR detail pages. Keyed per issue / PR; event-polling invalidation (workflow_run.* /
// workflow_step.* / workflow_artifact.* in lib/event-keys.ts) keeps the state fresh as the run advances.
// The query resolves to null when the issue / PR has no run.

import { useQuery } from "@tanstack/react-query";
import {
  getWorkflowRunStateForIssue,
  getWorkflowRunStateForPull,
} from "@/api/client";
import { queryKeys } from "./keys";

/** Latest Workflow run linked to an issue, or null. */
export function useWorkflowRunForIssue(
  owner: string,
  repo: string,
  number: number,
) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.workflowRunForIssue(full, number),
    queryFn: () => getWorkflowRunStateForIssue(full, number),
  });
}

/** Latest Workflow run linked to a PR, or null. */
export function useWorkflowRunForPull(
  owner: string,
  repo: string,
  number: number,
) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.workflowRunForPull(full, number),
    queryFn: () => getWorkflowRunStateForPull(full, number),
  });
}
