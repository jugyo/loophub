// Query + mutation hooks for the PR list, merged list, and detail screens.
// Query keys come from the shared factory (./keys), so the SSE invalidation map
// (../lib/event-keys.ts) refetches these on pull_request.* events.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPull,
  getPullDebug,
  getPullResumable,
  listEvents,
  listPullComments,
  listPullFiles,
  listPullReviewNotes,
  listPullReviews,
  listPulls,
  mergePull,
  patchPull,
  readyForReview,
} from "@/api/client";
import { queryKeys } from "./keys";

/** A `dev.note` event projected to the fields the PR timeline renders. */
export interface DevNote {
  id: number;
  actor: string;
  created_at: string;
  kind: string;
  summary: string;
  body?: string;
}

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
 * Whether this PR's dev session can be resumed now (#276): a stored session id plus a surviving
 * worktree or head branch (decideResume). Drives the PR-detail Resume button, shown only when true.
 * Keyed under the pull key so the SSE map (event-keys.ts) refetches it on pull_request.* events —
 * resumability changes when the worktree is pruned or the branch advances/removed.
 */
export function usePullResumable(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "resumable"],
    queryFn: () => getPullResumable(owner, repo, number),
  });
}

/**
 * Read-only debug dump for a PR (#248): raw DB rows + git facts + reviews/comments/notes/events.
 * `enabled` gates the fetch so the (potentially heavy, git-fanning) call only runs when the debug
 * modal is open. Kept off the SSE invalidation map — it is a manual, on-demand inspection surface.
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
 * Per-file review notes for a PR (#217), grouped by path at the call site. Keyed under the
 * pull key so the SSE map (event-keys.ts) refetches it via the pull prefix on
 * pull_request.review_note_* events. Notes span the PR's commit ranges; the diff view marks
 * those whose commit_sha differs from the current head as stale.
 */
export function usePullReviewNotes(
  owner: string,
  repo: string,
  number: number,
) {
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "review-notes"],
    queryFn: () => listPullReviewNotes(owner, repo, number),
  });
}

/**
 * Dev-loop notes (`dev.note` events) for a PR, oldest first. Sourced from the raw events
 * feed (no dedicated endpoint) and filtered client-side to this PR. Keyed under the pull
 * key so the SSE map (event-keys.ts) refetches it via the pull prefix on each new note.
 *
 * MVP limitation: events/list has no type filter and caps at 100 events, so this reads only
 * the latest 100 repo events. On a very busy repo, older dev notes for a PR can fall outside
 * that window. A type filter or dedicated endpoint would lift the cap (deferred — this is a
 * walking-skeleton MVP).
 */
export function usePullDevNotes(owner: string, repo: string, number: number) {
  const repoFull = full(owner, repo);
  return useQuery({
    queryKey: [...queryKeys.pull(repoFull, number), "dev-notes"],
    queryFn: async (): Promise<DevNote[]> => {
      const events = await listEvents(
        `repo=${repoFull}&order=desc&per_page=100`,
      );
      return (
        events
          .filter(
            (e) => e.type === "dev.note" && e.payload?.pr_number === number,
          )
          .map((e) => ({
            id: e.id,
            actor: e.actor,
            created_at: e.created_at,
            kind: String(e.payload.kind ?? ""),
            summary: String(e.payload.summary ?? ""),
            body:
              typeof e.payload.body === "string" ? e.payload.body : undefined,
          }))
          // Oldest first; event id breaks ties (created_at is second-precision).
          .sort(
            (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
          )
      );
    },
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
