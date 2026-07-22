// Query + mutation hooks for PR list and detail screens.
// Query keys come from the shared factory (./keys), so the event invalidation map
// (../lib/event-keys.ts) refetches these on pull_request.* events.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deletePull,
  getGithubPrStatus,
  getPull,
  getPullDebug,
  getPullFileAtRef,
  listPullComments,
  listPullCommitFiles,
  listPullFiles,
  listPullReviews,
  mergePull,
  patchPull,
  pushGithubPull,
  readyForReview,
} from "@/api/client";
import type { PullRequest } from "@/api/types";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

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

/** One PR commit's changed files, compared with its first parent. */
export function usePullCommitFiles(
  owner: string,
  repo: string,
  number: number,
  sha: string,
) {
  return useQuery({
    queryKey: [
      ...queryKeys.pull(full(owner, repo), number),
      "commitFiles",
      sha,
    ],
    queryFn: () => listPullCommitFiles(owner, repo, number, sha),
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
 * GitHub-side status (#850) of a PR's linked GitHub PR, for the detail sidebar. `enabled` gates the
 * fetch so it only runs once the PR is known to have a linked GitHub PR (no point calling an endpoint
 * that 404s otherwise). Keyed under the pull key so pull_request.* events refetch it via the prefix.
 */
export function useGithubPrStatus(
  owner: string,
  repo: string,
  number: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "githubStatus"],
    queryFn: () => getGithubPrStatus(owner, repo, number),
    enabled,
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
  // Issue detail embeds every linked PR's state and comparison metrics.
  qc.invalidateQueries({ queryKey: queryKeys.issues(full(owner, repo)) });
  qc.invalidateQueries({ queryKey: ["issue", full(owner, repo)] });
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

/** Push local changes to the linked GitHub PR's branch, then invalidate the PR + lists (#848). */
export function usePushGithubPull(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pushGithubPull(owner, repo, number),
    onSuccess: (githubPull) => {
      qc.setQueryData<PullRequest>(
        queryKeys.pull(full(owner, repo), number),
        (current) =>
          current ? { ...current, github_pull: githubPull } : current,
      );
      invalidatePull(qc, owner, repo, number);
    },
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

export function useDeletePull(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => deletePull(owner, repo, number),
    onSuccess: () => invalidatePull(qc, owner, repo, number),
  });
}
