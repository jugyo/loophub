// Query + mutation hooks for the PR list, merged list, and detail screens.
// Query keys come from the shared factory (./keys), so the event invalidation map
// (../lib/event-keys.ts) refetches these on pull_request.* events.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPull,
  getPullDebug,
  getPullFileAtRef,
  listPullComments,
  listPullFiles,
  listPullHandoffs,
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

/**
 * Read-only debug dump for a PR (#248): raw DB rows + git facts + reviews/comments/notes/events.
 * `enabled` gates the fetch so the (potentially heavy, git-fanning) call only runs when the debug
 * modal is open. Kept off the event invalidation map — it is a manual, on-demand inspection surface.
 */
export function usePullDebug(
  owner: string,
  repo: string,
  number: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "debug"],
    queryFn: () => getPullDebug(owner, repo, number),
    enabled,
  });
}

/** Changed files + diffs for a PR. */
export function usePullFiles(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "files"],
    queryFn: () => listPullFiles(owner, repo, number),
  });
}

/**
 * Whole-file content of one file at one side (base/head) of a PR (#435), for the Markdown
 * preview modal. `enabled` gates the fetch so it only runs once the modal is open.
 */
export function usePullFileAtRef(
  owner: string,
  repo: string,
  number: number,
  path: string,
  side: "base" | "head",
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      ...queryKeys.pull(full(owner, repo), number),
      "fileAtRef",
      side,
      path,
    ],
    queryFn: () => getPullFileAtRef(owner, repo, number, path, side),
    enabled,
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

/**
 * Orchestrator<->subagent handoffs (#352) for a PR, chronological. Keyed under the pull key so the
 * event map (event-keys.ts) refetches it via the pull prefix on each `handoff.recorded` event. Backed
 * by the dedicated handoffs/list endpoint (not the events feed), so there is no 100-event cap.
 */
export function usePullHandoffs(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "handoffs"],
    queryFn: () => listPullHandoffs(owner, repo, number),
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
export function useReadyForReview(owner: string, repo: string, number: number) {
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
