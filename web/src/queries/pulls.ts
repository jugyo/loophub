// Query + mutation hooks for PR list and detail screens.
// Query keys come from the shared factory (./keys), so the event invalidation map
// (../lib/event-keys.ts) refetches these on pull_request.* events.

import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  archivePull,
  createDiffFeedback,
  getGithubPrStatus,
  getPull,
  getPullDebug,
  getPullDetailPage,
  getPullDiff,
  getPullFileAtRef,
  getPullUsage,
  listCommitFiles,
  listDiffFeedback,
  listPullComments,
  listPullFiles,
  listPullFileViews,
  listPullReviews,
  markGithubMerged,
  mergePull,
  patchPull,
  postPullComment,
  pushGithubPull,
  reactToDiffFeedback,
  reactToPullComment,
  replyDiffFeedback,
  setDiffFeedbackArchived,
  setPullCommentArchived,
  setPullFileViewed,
  unarchivePull,
  unlinkGithubPull,
} from "@/api/client";
import type {
  DiffFeedbackList,
  DiffFeedbackMessage,
  DiffFeedbackThread,
  PullRequest,
} from "@/api/types";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** Single PR (detail), including linked_issue and review_state. */
export function usePull(
  owner: string,
  repo: string,
  number: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.pull(full(owner, repo), number),
    queryFn: () => getPull(owner, repo, number),
    enabled,
  });
}

export function usePullDetailPage(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...queryKeys.pull(full(owner, repo), number), "pageData"],
    queryFn: async () => {
      const data = await getPullDetailPage(owner, repo, number);
      const repoFull = full(owner, repo);
      // Seed through the same key factories the per-section hooks read, so the
      // disabled hooks in PullDetail resolve against this one fetch.
      qc.setQueryData(queryKeys.pull(repoFull, number), data.pull);
      qc.setQueryData(queryKeys.pullFiles(repoFull, number), data.files);
      qc.setQueryData(queryKeys.pullReviews(repoFull, number), data.reviews);
      qc.setQueryData(
        queryKeys.pullReviewComments(repoFull, number),
        data.line_comments,
      );
      qc.setQueryData(queryKeys.issueComments(repoFull, number), data.comments);
      // Previous threads read the orphaned scope of the diff feedback list; the counts ride
      // along so the seeded entry is the whole list shape the mutation helpers expect (#123).
      qc.setQueryData<DiffFeedbackList>(
        [...feedbackKey(owner, repo, number), { orphaned: true }],
        {
          threads: data.diff_feedback.orphaned_threads,
          comment_counts: data.diff_feedback.comment_counts,
        },
      );
      return data;
    },
  });
}

/**
 * A PR's agent-cost totals alone (#2263). Split off `usePull` so the usage counter — which ticks
 * every few seconds while an agent runs — refreshes on a query the server answers from the DB,
 * leaving the git-backed PR/issue detail to the events that actually change it.
 */
export function usePullUsage(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: queryKeys.pullUsage(full(owner, repo), number),
    queryFn: () => getPullUsage(owner, repo, number),
  });
}

/**
 * Read-only debug dump for a PR (#248): raw DB rows + git facts + reviews/comments/notes/events.
 * `enabled` gates the fetch so the (potentially heavy, git-fanning) call only runs when the debug
 * modal is open. Its independent key is refreshed by events that change the assembled dump without
 * inheriting unrelated invalidations from the regular pull detail.
 */
export function usePullDebug(
  owner: string,
  repo: string,
  number: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.pullDebug(full(owner, repo), number),
    queryFn: () => getPullDebug(owner, repo, number),
    enabled,
  });
}

/** Changed files + diffs for a PR. */
export function usePullFiles(
  owner: string,
  repo: string,
  number: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.pullFiles(full(owner, repo), number),
    queryFn: () => listPullFiles(owner, repo, number),
    enabled,
  });
}

/** Which changed files are marked viewed, and the version each was marked at (#2502). */
export function usePullFileViews(owner: string, repo: string, number: number) {
  return useQuery({
    queryKey: queryKeys.pullFileViews(full(owner, repo), number),
    queryFn: () => listPullFileViews(owner, repo, number),
  });
}

/**
 * Mark one changed file viewed or not viewed. The call returns the PR's viewed files afterwards,
 * so the list is written straight into the cache: the toggle sits in the diff dialog, where a
 * refetch round trip would leave the checkbox lagging behind the click.
 */
export function useSetPullFileViewed(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      path: string;
      sha: string | null;
      viewed: boolean;
    }) => setPullFileViewed(owner, repo, number, input),
    onSuccess: (views) =>
      qc.setQueryData(
        queryKeys.pullFileViews(full(owner, repo), number),
        views,
      ),
  });
}

const feedbackKey = (owner: string, repo: string, number: number) => [
  ...queryKeys.pull(full(owner, repo), number),
  "diffFeedback",
];

let nextOptimisticId = -1;

type FeedbackSnapshot = [QueryKey, DiffFeedbackList | undefined][];

function snapshotFeedback(
  qc: QueryClient,
  owner: string,
  repo: string,
  number: number,
): FeedbackSnapshot {
  return qc.getQueriesData<DiffFeedbackList>({
    queryKey: feedbackKey(owner, repo, number),
  });
}

function restoreFeedback(qc: QueryClient, snapshot: FeedbackSnapshot) {
  for (const [key, data] of snapshot) {
    if (data) qc.setQueryData(key, data);
    else {
      qc.setQueryData<DiffFeedbackList>(key, {
        threads: [],
        comment_counts: {},
      });
    }
  }
}

function updateFeedback(
  qc: QueryClient,
  owner: string,
  repo: string,
  number: number,
  update: (data: DiffFeedbackList) => DiffFeedbackList,
) {
  for (const [key, data] of snapshotFeedback(qc, owner, repo, number)) {
    if (data) qc.setQueryData(key, update(data));
  }
}

export function usePullDiff(
  owner: string,
  repo: string,
  number: number,
  path: string,
  ignoreWhitespace = false,
) {
  return useQuery({
    queryKey: [
      ...queryKeys.pull(full(owner, repo), number),
      "stableDiff",
      path,
      { ignoreWhitespace },
    ],
    queryFn: () => getPullDiff(owner, repo, number, path, ignoreWhitespace),
  });
}

export function useDiffFeedback(
  owner: string,
  repo: string,
  number: number,
  scope: { path?: string; orphaned?: boolean } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: [...feedbackKey(owner, repo, number), scope],
    queryFn: () => listDiffFeedback(owner, repo, number, scope),
    enabled,
  });
}

export function useCreateDiffFeedback(
  owner: string,
  repo: string,
  number: number,
  path: string,
  handleError?: (
    error: unknown,
    input: Parameters<typeof createDiffFeedback>[3],
  ) => void,
) {
  const qc = useQueryClient();
  const queryKey = [...feedbackKey(owner, repo, number), { path }];
  return useMutation({
    mutationFn: (input: Parameters<typeof createDiffFeedback>[3]) =>
      createDiffFeedback(owner, repo, number, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey, exact: true });
      const previous: FeedbackSnapshot = [
        [queryKey, qc.getQueryData<DiffFeedbackList>(queryKey)],
      ];
      const threadId = nextOptimisticId--;
      const messageId = nextOptimisticId--;
      const createdAt = new Date().toISOString();
      const thread: DiffFeedbackThread = {
        id: threadId,
        pr_number: number,
        anchor: {
          base_sha: input.base_sha,
          head_sha: input.head_sha,
          path: input.path,
          original_path: null,
          side: input.side,
          start_line: input.start_line,
          end_line: input.end_line,
        },
        resolved_anchor: {
          path: input.path,
          original_path: null,
          side: input.side,
          start_line: input.start_line,
          end_line: input.end_line,
        },
        freshness: "current",
        outdated_reason: null,
        placement: "inline",
        original_context: null,
        archived_at: null,
        created_by: "me",
        created_by_type: "human",
        created_at: createdAt,
        messages: [
          {
            id: messageId,
            thread_id: threadId,
            author: "me",
            author_type: "human",
            body: input.body,
            created_at: createdAt,
            reactions: [],
          },
        ],
      };
      qc.setQueryData<DiffFeedbackList>(queryKey, (data) => ({
        threads: [...(data?.threads ?? []), thread],
        comment_counts: data?.comment_counts ?? {},
      }));
      return { previous };
    },
    onError: (error, input, context) => {
      if (context) restoreFeedback(qc, context.previous);
      handleError?.(error, input);
    },
    onSettled: () =>
      qc.invalidateQueries({ queryKey: feedbackKey(owner, repo, number) }),
  });
}

export function useReplyDiffFeedback(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: number; body: string }) =>
      replyDiffFeedback(owner, repo, number, input.threadId, input.body),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: feedbackKey(owner, repo, number) });
      const previous = snapshotFeedback(qc, owner, repo, number);
      const messageId = nextOptimisticId--;
      const reply: DiffFeedbackMessage = {
        id: messageId,
        thread_id: input.threadId,
        author: "me",
        author_type: "human",
        body: input.body,
        created_at: new Date().toISOString(),
        reactions: [],
      };
      updateFeedback(qc, owner, repo, number, (data) => ({
        ...data,
        threads: data.threads.map((thread) =>
          thread.id === input.threadId
            ? { ...thread, messages: [...thread.messages, reply] }
            : thread,
        ),
      }));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context) restoreFeedback(qc, context.previous);
    },
    onSettled: () =>
      qc.invalidateQueries({ queryKey: feedbackKey(owner, repo, number) }),
  });
}

export function useReactToDiffFeedback(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { messageId: number; emoji: string }) =>
      reactToDiffFeedback(owner, repo, number, input.messageId, input.emoji),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: feedbackKey(owner, repo, number) });
      const previous = snapshotFeedback(qc, owner, repo, number);
      updateFeedback(qc, owner, repo, number, (data) => ({
        ...data,
        threads: data.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) => {
            if (message.id !== input.messageId) return message;
            const selected = message.reactions.find(
              (reaction) => reaction.reacted,
            );
            const reactions = message.reactions
              .map((reaction) =>
                reaction.reacted
                  ? {
                      ...reaction,
                      count: reaction.count - 1,
                      reacted: false,
                    }
                  : reaction,
              )
              .filter((reaction) => reaction.count > 0);
            if (selected?.emoji === input.emoji) {
              return { ...message, reactions };
            }
            const target = reactions.find(
              (reaction) => reaction.emoji === input.emoji,
            );
            return {
              ...message,
              reactions: target
                ? reactions.map((reaction) =>
                    reaction.emoji === input.emoji
                      ? {
                          ...reaction,
                          count: reaction.count + 1,
                          reacted: true,
                        }
                      : reaction,
                  )
                : [
                    ...reactions,
                    { emoji: input.emoji, count: 1, reacted: true },
                  ],
            };
          }),
        })),
      }));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context) restoreFeedback(qc, context.previous);
    },
    onSettled: () =>
      qc.invalidateQueries({ queryKey: feedbackKey(owner, repo, number) }),
  });
}

export function useSetDiffFeedbackArchived(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: number; archived: boolean }) =>
      setDiffFeedbackArchived(
        owner,
        repo,
        number,
        input.threadId,
        input.archived,
      ),
    // Archiving has no optimistic update and emits no event, so a refetch is the only thing that
    // moves the card to its archived form. The PR detail screen reads the orphaned threads from
    // its page query, whose key sits beside the diff feedback ones under the pull prefix — so
    // invalidate the prefix, or archiving a previous thread would look like nothing happened
    // (#123).
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: queryKeys.pull(full(owner, repo), number),
      }),
  });
}

/** One repository commit's changed files, compared with its first parent. */
export function useCommitFiles(owner: string, repo: string, sha: string) {
  return useQuery({
    queryKey: ["repo", full(owner, repo), "commitFiles", sha],
    queryFn: () => listCommitFiles(owner, repo, sha),
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
export function usePullReviews(
  owner: string,
  repo: string,
  number: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.pullReviews(full(owner, repo), number),
    queryFn: () => listPullReviews(owner, repo, number),
    enabled,
  });
}

/** Line comments for a PR, grouped by path at the call site. */
export function usePullComments(
  owner: string,
  repo: string,
  number: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.pullReviewComments(full(owner, repo), number),
    queryFn: () => listPullComments(owner, repo, number),
    enabled,
  });
}

export function usePostPullComment(
  owner: string,
  repo: string,
  number: number,
  handleError?: (error: unknown, body: string) => void,
) {
  const qc = useQueryClient();
  const commentsKey = queryKeys.issueComments(full(owner, repo), number);
  return useMutation({
    mutationFn: (body: string) => postPullComment(owner, repo, number, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: commentsKey });
      const previous =
        qc.getQueryData<Awaited<ReturnType<typeof postPullComment>>[]>(
          commentsKey,
        );
      const optimisticId = nextOptimisticId--;
      qc.setQueryData(commentsKey, [
        ...(previous ?? []),
        {
          id: optimisticId,
          user: { login: "me" },
          author_type: "human",
          body,
          created_at: new Date().toISOString(),
          reactions: [],
        },
      ]);
      return { previous };
    },
    onError: (error, body, context) => {
      if (context) qc.setQueryData(commentsKey, context.previous ?? []);
      handleError?.(error, body);
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({
          queryKey: queryKeys.pull(full(owner, repo), number),
        }),
        qc.invalidateQueries({
          queryKey: queryKeys.pullDebug(full(owner, repo), number),
        }),
        qc.invalidateQueries({ queryKey: commentsKey }),
      ]),
  });
}

export function useReactToPullComment(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  const commentsKey = queryKeys.issueComments(full(owner, repo), number);
  return useMutation({
    mutationFn: (input: { commentId: number; emoji: string }) =>
      reactToPullComment(owner, repo, number, input.commentId, input.emoji),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: commentsKey });
      const previous =
        qc.getQueryData<Awaited<ReturnType<typeof postPullComment>>[]>(
          commentsKey,
        );
      qc.setQueryData<typeof previous>(
        commentsKey,
        previous?.map((comment) => {
          if (comment.id !== input.commentId) return comment;
          const selected = comment.reactions.find(
            (reaction) => reaction.reacted,
          );
          const reactions = comment.reactions
            .map((reaction) =>
              reaction.reacted
                ? {
                    ...reaction,
                    count: reaction.count - 1,
                    reacted: false,
                  }
                : reaction,
            )
            .filter((reaction) => reaction.count > 0);
          if (selected?.emoji === input.emoji) {
            return { ...comment, reactions };
          }
          const target = reactions.find(
            (reaction) => reaction.emoji === input.emoji,
          );
          return {
            ...comment,
            reactions: target
              ? reactions.map((reaction) =>
                  reaction.emoji === input.emoji
                    ? {
                        ...reaction,
                        count: reaction.count + 1,
                        reacted: true,
                      }
                    : reaction,
                )
              : [...reactions, { emoji: input.emoji, count: 1, reacted: true }],
          };
        }),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context) qc.setQueryData(commentsKey, context.previous ?? []);
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: commentsKey }),
        qc.invalidateQueries({
          queryKey: [...queryKeys.pull(full(owner, repo), number), "pageData"],
        }),
      ]),
  });
}

export function useSetPullCommentArchived(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  const commentsKey = queryKeys.issueComments(full(owner, repo), number);
  return useMutation({
    mutationFn: (input: { commentId: number; archived: boolean }) =>
      setPullCommentArchived(
        owner,
        repo,
        number,
        input.commentId,
        input.archived,
      ),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: commentsKey }),
        qc.invalidateQueries({
          queryKey: [...queryKeys.pull(full(owner, repo), number), "pageData"],
        }),
      ]),
  });
}

/**
 * GitHub-side status (#850) of a PR's linked GitHub PR, for the detail sidebar. `enabled` gates the
 * fetch so it only runs once the PR is known to have a linked GitHub PR (no point calling an endpoint
 * that 404s otherwise). Its independent key is refreshed only by GitHub-link/status events.
 */
export function useGithubPrStatus(
  owner: string,
  repo: string,
  number: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.githubPrStatus(full(owner, repo), number),
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
  // Every PR mutation changes the debug dump's row and/or event history. This used to be covered
  // implicitly while pullDebug was a child of the pull detail key.
  qc.invalidateQueries({
    queryKey: queryKeys.pullDebug(full(owner, repo), number),
  });
  // Issue detail embeds every linked PR's state and comparison metrics.
  qc.invalidateQueries({ queryKey: queryKeys.issues(full(owner, repo)) });
  qc.invalidateQueries({ queryKey: ["issue", full(owner, repo)] });
}

/** Merge a PR, then invalidate the PR and git-derived lists. */
export function useMergePull(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mergeMethod: "squash" | "merge" | "rebase") =>
      mergePull(owner, repo, number, mergeMethod),
    onSuccess: () => {
      invalidatePull(qc, owner, repo, number);
      qc.invalidateQueries({
        queryKey: queryKeys.pullFiles(full(owner, repo), number),
      });
      qc.invalidateQueries({
        queryKey: queryKeys.workspaces(full(owner, repo)),
      });
    },
  });
}

export function useMarkGithubMerged(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => markGithubMerged(owner, repo, number),
    onSuccess: () => invalidatePull(qc, owner, repo, number),
  });
}

/**
 * Push local changes to the linked GitHub PR's branch, then invalidate the PR + lists (#848).
 * `mutate(true)` force-pushes (#1861) for a head rewritten by rebase/amend.
 */
export function usePushGithubPull(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (force?: boolean) => pushGithubPull(owner, repo, number, force),
    onSuccess: (githubPull) => {
      qc.setQueryData<PullRequest>(
        queryKeys.pull(full(owner, repo), number),
        (current) =>
          current ? { ...current, github_pull: githubPull } : current,
      );
      invalidatePull(qc, owner, repo, number);
      qc.invalidateQueries({
        queryKey: queryKeys.githubPrStatus(full(owner, repo), number),
      });
    },
  });
}

/**
 * Drop the PR's GitHub PR link (#2384), then invalidate the PR + lists. The cached PR is patched to
 * `github_pull: null` right away so the action row flips back to "Create PR on GitHub" without
 * waiting for the refetch, and the GitHub status query is removed rather than invalidated — with no
 * link the endpoint 404s, so a refetch would only produce an error.
 */
export function useUnlinkGithubPull(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unlinkGithubPull(owner, repo, number),
    onSuccess: () => {
      qc.setQueryData<PullRequest>(
        queryKeys.pull(full(owner, repo), number),
        (current) => (current ? { ...current, github_pull: null } : current),
      );
      qc.removeQueries({
        queryKey: queryKeys.githubPrStatus(full(owner, repo), number),
      });
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

export function useArchivePull(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => archivePull(owner, repo, number),
    onSuccess: () => invalidatePull(qc, owner, repo, number),
  });
}

export function useUnarchivePull(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unarchivePull(owner, repo, number),
    onSuccess: () => invalidatePull(qc, owner, repo, number),
  });
}
