// Query + mutation hooks for the PR list, merged list, and detail screens.
// Query keys come from the shared factory (./keys), so the SSE invalidation map
// (../lib/event-keys.ts) refetches these on pull_request.* events.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPull,
  listPullComments,
  listPullFiles,
  listPullReviews,
  listPulls,
  mergePull,
  patchPull,
  readyForReview,
} from "@/api/client";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** State filter for the PR list view (merged list pins its own query). */
export type PullListState = "open" | "closed" | "all";

export const DEFAULT_PULL_STATE: PullListState = "open";

/** PR list with v1-parity state filter. */
export function usePullsList(
  owner: string,
  repo: string,
  state: PullListState,
) {
  return useQuery({
    queryKey: [...queryKeys.pulls(full(owner, repo)), "list", state],
    queryFn: () => listPulls(owner, repo, `state=${state}`),
  });
}

/** Merged PRs (state=closed&merged=only), mirroring the dashboard query. */
export function useMergedPullsList(owner: string, repo: string) {
  return useQuery({
    queryKey: [...queryKeys.pulls(full(owner, repo)), "merged", "list"],
    queryFn: () => listPulls(owner, repo, "state=closed&merged=only"),
  });
}

/** Single PR (detail), including linked_issue and review_state. */
export function usePull(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: queryKeys.pull(full(owner, repo), number),
    queryFn: () => getPull(owner, repo, number),
  });
}

/** Changed files + diffs for a PR. */
export function usePullFiles(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "files"],
    queryFn: () => listPullFiles(owner, repo, number),
  });
}

/** Submitted reviews for a PR. */
export function usePullReviews(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "reviews"],
    queryFn: () => listPullReviews(owner, repo, number),
  });
}

/** Line comments for a PR, grouped by path at the call site. */
export function usePullComments(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "comments"],
    queryFn: () => listPullComments(owner, repo, number),
  });
}

function invalidatePull(
  qc: ReturnType<typeof useQueryClient>,
  owner: string,
  repo: string,
  number: number,
) {
  qc.invalidateQueries({ queryKey: queryKeys.pull(full(owner, repo), number) });
  qc.invalidateQueries({ queryKey: queryKeys.pulls(full(owner, repo)) });
}

/** Merge a PR, then invalidate the PR + lists. */
export function useMergePull(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mergeMethod: "squash" | "merge" | "rebase") =>
      mergePull(owner, repo, number, mergeMethod),
    onSuccess: () => invalidatePull(qc, owner, repo, number),
  });
}

/** Mark a PR ready for re-review, then invalidate the PR + lists. */
export function useReadyForReview(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => readyForReview(owner, repo, number),
    onSuccess: () => invalidatePull(qc, owner, repo, number),
  });
}

/** Toggle PR state (open <-> closed) without merging, then invalidate. */
export function useSetPullState(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (state: "open" | "closed") =>
      patchPull(owner, repo, number, { state }),
    onSuccess: () => invalidatePull(qc, owner, repo, number),
  });
}
