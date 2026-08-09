// Workflow run display-state query hooks (#1008): the latest run linked to an issue / PR, shown on the
// issue and PR detail pages. Keyed per issue / PR; event-polling invalidation (workflow_run.* /
// workflow_step.* in lib/event-keys.ts) keeps the state fresh as the run advances.
// The query resolves to null when the issue / PR has no run.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getWorkflowRunAgentCosts,
  getWorkflowRunHistory,
  getWorkflowRunStateForPull,
  getWorkflowRunTotalCost,
  increaseWorkflowRunCostLimit,
} from "@/api/client";
import { queryKeys } from "./keys";

/** Latest Workflow run linked to a PR, or null. */
export function useWorkflowRunForPull(
  owner: string,
  repo: string,
  number: number,
  // #112: an issue-list row passes false. Its state arrives with the page (pageData/issueList seeds
  // this key), so fetching per row would put one request per row on lh-web at once — which is what
  // folding it into the page removed. Detail screens, which ask about one PR, keep fetching.
  enabled = true,
) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.workflowRunForPull(full, number),
    queryFn: () => getWorkflowRunStateForPull(full, number),
    enabled,
  });
}

/**
 * Increase the budget of the cost-held run linked to a PR. The run state is refetched on success so
 * the new limit is visible without waiting for the event poll.
 */
export function useIncreaseWorkflowRunCostLimit(
  owner: string,
  repo: string,
  pull: number,
) {
  const full = `${owner}/${repo}`;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      run,
      expectedLimitUsd,
    }: {
      run: number;
      expectedLimitUsd: number;
    }) => increaseWorkflowRunCostLimit(full, run, expectedLimitUsd),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.workflowRunForPull(full, pull),
        }),
        // #112: on a list row that key is seeded by pageData/issueList and its query is disabled,
        // so the refetch that actually clears the hold is the page's.
        queryClient.invalidateQueries({ queryKey: queryKeys.issues(full) }),
      ]);
    },
  });
}

/** Run-scoped lifecycle history. Disabled until the PR detail dialog is opened. */
export function useWorkflowRunHistory(
  owner: string,
  repo: string,
  run: number,
  enabled: boolean,
) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.workflowRunHistory(full, run),
    queryFn: () => getWorkflowRunHistory(full, run),
    enabled,
  });
}

/** Persisted participants and costs. Disabled until the Workflow detail dialog is opened. */
export function useWorkflowRunAgentCosts(
  owner: string,
  repo: string,
  run: number,
  enabled: boolean,
) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.workflowRunAgentCosts(full, run),
    queryFn: () => getWorkflowRunAgentCosts(full, run),
    enabled,
  });
}

/** Core-calculated run total shown whenever the PR sidebar's Workflow section is visible. */
export function useWorkflowRunTotalCost(
  owner: string,
  repo: string,
  run: number,
  enabled: boolean,
) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.workflowRunTotalCost(full, run),
    queryFn: () => getWorkflowRunTotalCost(full, run),
    enabled,
  });
}
