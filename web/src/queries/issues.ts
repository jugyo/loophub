// Query + mutation hooks for the issue list and detail screens. Query keys come
// from the shared factory (./keys), so the SSE invalidation map
// (../lib/event-keys.ts) refetches these lists and details on change.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addIssueLabels,
  createIssue,
  getIssue,
  listIssueComments,
  listIssues,
  patchIssue,
  postIssueComment,
} from "@/api/client";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** Label a human applies to greenlight AFK agents to start work. */
export const READY_TO_BUILD_LABEL = "ready-to-build";

/** Filters for the issue list view (mirrors v1 listState / labels). */
export interface IssueListFilters {
  state: "open" | "closed" | "all";
  labels: string;
}

export const DEFAULT_ISSUE_FILTERS: IssueListFilters = {
  state: "open",
  labels: "",
};

/** Issue list with v1-parity state + labels filters (PRs excluded). */
export function useIssuesList(
  owner: string,
  repo: string,
  filters: IssueListFilters,
) {
  return useQuery({
    queryKey: [...queryKeys.issues(full(owner, repo)), "list", filters],
    queryFn: () => {
      const params = new URLSearchParams({
        kind: "issue",
        state: filters.state,
      });
      const labels = filters.labels.trim();
      if (labels) params.set("labels", labels);
      return listIssues(owner, repo, params.toString());
    },
  });
}

/** Single issue (detail), including linked_pull_request. */
export function useIssue(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: queryKeys.issue(full(owner, repo), number),
    queryFn: () => getIssue(owner, repo, number),
  });
}

/** Comments for an issue, oldest first (server order). */
export function useIssueComments(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: [...queryKeys.issue(full(owner, repo), number), "comments"],
    queryFn: () => listIssueComments(owner, repo, number),
  });
}

/** Post a comment, then invalidate the issue + its comments. */
export function usePostComment(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => postIssueComment(owner, repo, number, body),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.issue(full(owner, repo), number),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.issues(full(owner, repo)),
      });
    },
  });
}

/** Toggle issue state (open <-> closed), then invalidate issue + lists. */
export function useSetIssueState(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (state: "open" | "closed") =>
      patchIssue(owner, repo, number, { state }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.issue(full(owner, repo), number),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.issues(full(owner, repo)),
      });
    },
  });
}

/**
 * Add the `ready-to-build` label to an issue, then invalidate issue + lists.
 * The button is hidden once the label is present (see issue-detail), so this is
 * add-only. SSE also refetches via the "issue.labeled" event, but invalidating
 * on success keeps the click responsive without waiting for the round-trip.
 */
export function useAddReadyToBuild(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      addIssueLabels(owner, repo, number, [READY_TO_BUILD_LABEL]),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.issue(full(owner, repo), number),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.issues(full(owner, repo)),
      });
    },
  });
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

/** Create an issue, then invalidate the repo's issue lists. */
export function useCreateIssue(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIssueInput) => createIssue(owner, repo, input),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.issues(full(owner, repo)),
      });
    },
  });
}
