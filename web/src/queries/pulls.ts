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
  createDiffFeedback,
  deletePull,
  getGithubPrStatus,
  getPull,
  getPullDebug,
  getPullDiff,
  getPullFileAtRef,
  listDiffFeedback,
  listPullComments,
  listPullCommitFiles,
  listPullFiles,
  listPullReviews,
  mergePull,
  patchPull,
  postPullComment,
  pushGithubPull,
  reactToDiffFeedback,
  reactToPullComment,
  replyDiffFeedback,
  setDiffFeedbackResolved,
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
) {
  return useQuery({
    queryKey: [...feedbackKey(owner, repo, number), scope],
    queryFn: () => listDiffFeedback(owner, repo, number, scope),
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
        resolved: false,
        resolved_by: null,
        resolved_at: null,
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

export function useSetDiffFeedbackResolved(
  owner: string,
  repo: string,
  number: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: number; resolved: boolean }) =>
      setDiffFeedbackResolved(
        owner,
        repo,
        number,
        input.threadId,
        input.resolved,
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: feedbackKey(owner, repo, number) }),
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

export function usePostPullComment(
  owner: string,
  repo: string,
  number: number,
  handleError?: (error: unknown, body: string) => void,
) {
  const qc = useQueryClient();
  const commentsKey = [
    ...queryKeys.issue(full(owner, repo), number),
    "comments",
  ];
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
  const commentsKey = [
    ...queryKeys.issue(full(owner, repo), number),
    "comments",
  ];
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
    onSettled: () => qc.invalidateQueries({ queryKey: commentsKey }),
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

/** Merge a PR, then invalidate the PR and git-derived lists. */
export function useMergePull(owner: string, repo: string, number: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mergeMethod: "squash" | "merge" | "rebase") =>
      mergePull(owner, repo, number, mergeMethod),
    onSuccess: () => {
      invalidatePull(qc, owner, repo, number);
      qc.invalidateQueries({
        queryKey: queryKeys.workspaces(full(owner, repo)),
      });
    },
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
