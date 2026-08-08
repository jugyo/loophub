// Query + mutation hooks for the issue list and detail screens. Query keys come
// from the shared factory (./keys), so the event invalidation map
// (../lib/event-keys.ts) refetches these lists and details on change.

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  addAcceptanceCriterion,
  createIssue,
  getIssue,
  getIssueDetailPage,
  getIssueListPage,
  listAcceptanceCriteria,
  listIssueComments,
  listIssueRefKinds,
  listLabels,
  patchIssue,
  postIssueComment,
  setAcceptanceCriterionEnabled,
} from "@/api/client";
import type { IssueRefTarget } from "@/lib/remark-issue-refs";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** Filters for the issue list view (mirrors v1 listState / labels). */
export interface IssueListFilters {
  state: "open" | "closed" | "all";
  labels: string;
  workspace?: string;
}

export const DEFAULT_ISSUE_FILTERS: IssueListFilters = {
  state: "open",
  labels: "",
};

export const ISSUE_LIST_PAGE_SIZE = 20;
const ISSUE_LIST_FETCH_SIZE = ISSUE_LIST_PAGE_SIZE + 1;

const acceptanceCriteriaKey = (repoFull: string, number: number) => [
  ...queryKeys.issue(repoFull, number),
  "acceptanceCriteria",
];

function hasMoreIssuePages(
  pages: Awaited<ReturnType<typeof getIssueListPage>>[],
) {
  const lastPage = pages.at(-1)?.issues ?? [];
  return lastPage.length > ISSUE_LIST_PAGE_SIZE;
}

/** Issue list with v1-parity state + labels filters (PRs excluded). */
export function useIssueListPage(
  owner: string,
  repo: string,
  filters: IssueListFilters,
  options: {
    includeLabels?: boolean;
  } = {},
) {
  return useInfiniteQuery({
    queryKey: [
      ...queryKeys.issues(full(owner, repo)),
      "listPage",
      filters,
      options,
    ],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        kind: "issue",
        state: filters.state,
        per_page: String(ISSUE_LIST_FETCH_SIZE),
        lookahead: "true",
        page: String(pageParam),
      });
      const labels = filters.labels.trim();
      if (labels) params.set("labels", labels);
      if (filters.workspace) params.set("workspace", filters.workspace);
      return getIssueListPage(owner, repo, params.toString(), options);
    },
    getNextPageParam: (_lastPage, allPages) =>
      hasMoreIssuePages(allPages) ? allPages.length + 1 : undefined,
  });
}

/** Labels available in this repo, for issue filters and editors. */
export function useLabelsList(owner: string, repo: string, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.labels(full(owner, repo))],
    queryFn: () => listLabels(owner, repo),
    enabled,
  });
}

/** Single issue (detail), including linked_pull_request. */
export function useIssue(
  owner: string,
  repo: string,
  number: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.issue(full(owner, repo), number),
    queryFn: () => getIssue(owner, repo, number),
    enabled,
  });
}

/**
 * Kinds of the references in one Markdown body, so the renderer can link each to its canonical
 * route (#2362). `targets` must be sorted and deduplicated by the caller (issueRefTargets does
 * this) — it is part of the query key, so bodies referencing the same set share one lookup.
 */
export function useIssueRefKinds(targets: readonly IssueRefTarget[]) {
  return useQuery({
    queryKey: queryKeys.issueRefKinds(targets),
    queryFn: () =>
      listIssueRefKinds(
        targets.map((t) => ({ repo: t.repo, numbers: [...t.numbers] })),
      ),
    enabled: targets.length > 0,
  });
}

export function useIssueDetailPage(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...queryKeys.issue(full(owner, repo), number), "pageData"],
    queryFn: async () => {
      const data = await getIssueDetailPage(owner, repo, number);
      const repoFull = full(owner, repo);
      // Seed through the same key factories the per-section hooks read, so the
      // disabled hooks in IssueDetail resolve against this one fetch.
      qc.setQueryData(queryKeys.issue(repoFull, number), data.issue);
      qc.setQueryData(queryKeys.issueComments(repoFull, number), data.comments);
      qc.setQueryData(
        acceptanceCriteriaKey(repoFull, number),
        data.acceptance_criteria,
      );
      return data;
    },
  });
}

export function useAcceptanceCriteria(
  owner: string,
  repo: string,
  number: number,
  enabled = true,
) {
  return useQuery({
    queryKey: acceptanceCriteriaKey(full(owner, repo), number),
    queryFn: () => listAcceptanceCriteria(owner, repo, number),
    enabled,
  });
}

function useInvalidateAcceptanceCriteria(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({
      queryKey: queryKeys.issue(full(owner, repo), number),
    });
    qc.invalidateQueries({ queryKey: queryKeys.issues(full(owner, repo)) });
  };
}

export function useAddAcceptanceCriterion(
  owner: string,
  repo: string,
  number: number,
) {
  const invalidate = useInvalidateAcceptanceCriteria(owner, repo, number);
  return useMutation({
    mutationFn: (text: string) =>
      addAcceptanceCriterion(owner, repo, number, text),
    onSuccess: invalidate,
  });
}

export function useSetAcceptanceCriterionEnabled(
  owner: string,
  repo: string,
  number: number,
) {
  const invalidate = useInvalidateAcceptanceCriteria(owner, repo, number);
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setAcceptanceCriterionEnabled(owner, repo, number, id, enabled),
    onSuccess: invalidate,
  });
}

/** Comments for an issue, oldest first (server order). */
export function useIssueComments(
  owner: string,
  repo: string,
  number: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.issueComments(full(owner, repo), number),
    queryFn: () => listIssueComments(owner, repo, number),
    enabled,
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
      qc.invalidateQueries({
        queryKey: queryKeys.issueComments(full(owner, repo), number),
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

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  target_branch?: string | null;
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
