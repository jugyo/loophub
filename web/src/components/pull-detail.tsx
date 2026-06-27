// PR detail view (/r/:owner/:repo/pulls/:number). v1 parity: title, body,
// state + review badges, head→base, the linked issue (bidirectional with the
// issue's linked PR), reviews, the file diff with line comments,
// issue comments, plus the write operations — merge (when APPROVED), "mark ready
// for re-review" (when CHANGES_REQUESTED), and close/reopen (when not merged).
// Body, reviews, and comments are stored as plain Markdown and rendered as GFM
// via <Markdown>.

import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import type {
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
} from "@/api/types";
import { useRegisterDetailTitle } from "@/components/detail-title";
import { PullDevInfo } from "@/components/dev-info";
import { DiffStat } from "@/components/diff-stat";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type BadgeTone,
  mergeableBadge,
  reviewBadge,
  stateBadge,
} from "@/lib/badges";
import { type DiffLineKind, parsePatch } from "@/lib/diff";
import { relativeTime } from "@/lib/time";
import { useIssueComments } from "@/queries/issues";
import {
  type DevNote,
  useMergePull,
  usePull,
  usePullComments,
  usePullDevNotes,
  usePullFiles,
  usePullReviews,
  useReadyForReview,
  useSetPullState,
} from "@/queries/pulls";

const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
type MergeMethod = (typeof MERGE_METHODS)[number];

export function PullDetail({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const pullQuery = usePull(owner, repo, number);
  const filesQuery = usePullFiles(owner, repo, number);
  const reviewsQuery = usePullReviews(owner, repo, number);
  const lineCommentsQuery = usePullComments(owner, repo, number);
  const commentsQuery = useIssueComments(owner, repo, number);
  const devNotesQuery = usePullDevNotes(owner, repo, number);

  if (pullQuery.isLoading) {
    return (
      <div className="mx-auto flex max-w-content items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (pullQuery.isError || !pullQuery.data) {
    return (
      <div className="mx-auto max-w-content rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load PR #{number}.
        {pullQuery.error instanceof Error
          ? ` ${pullQuery.error.message}`
          : null}
      </div>
    );
  }

  const pull = pullQuery.data;

  return (
    <div className="mx-auto flex max-w-content flex-col gap-6">
      <PullHeader owner={owner} repo={repo} pull={pull} />

      <DevNoteTimeline
        owner={owner}
        repo={repo}
        notes={devNotesQuery.data}
        isLoading={devNotesQuery.isLoading}
        isError={devNotesQuery.isError}
      />

      <ReviewList
        owner={owner}
        repo={repo}
        reviews={reviewsQuery.data}
        isLoading={reviewsQuery.isLoading}
        isError={reviewsQuery.isError}
      />

      <FilesChanged
        owner={owner}
        repo={repo}
        files={filesQuery.data}
        lineComments={lineCommentsQuery.data}
        isLoading={filesQuery.isLoading}
        isError={filesQuery.isError}
      />

      <CommentList
        owner={owner}
        repo={repo}
        comments={commentsQuery.data}
        isLoading={commentsQuery.isLoading}
        isError={commentsQuery.isError}
      />
    </div>
  );
}

function PullHeader({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
}) {
  const merge = useMergePull(owner, repo, pull.number);
  const ready = useReadyForReview(owner, repo, pull.number);
  const setState = useSetPullState(owner, repo, pull.number);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const titleRef = useRegisterDetailTitle(pull.title);

  const state = stateBadge(pull, "pulls");
  const review = reviewBadge(pull);
  const mergeable = mergeableBadge(pull);
  const linked = pull.linked_issue;

  const canAct = pull.state === "open" && !pull.merged;
  const canMerge = canAct && pull.review_state === "APPROVED";
  const canReady = canAct && pull.review_state === "CHANGES_REQUESTED";

  return (
    <div className="flex flex-col gap-3">
      <h1 ref={titleRef} className="text-2xl font-semibold">
        {pull.title}{" "}
        <span className="font-normal text-muted-foreground">
          #{pull.number}
        </span>
      </h1>

      <div className="flex flex-wrap items-center gap-2">
        {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
        {review ? <Badge tone={review.tone}>{review.label}</Badge> : null}
        {mergeable ? (
          <Badge tone={mergeable.tone} title={mergeable.title}>
            {mergeable.label}
          </Badge>
        ) : null}
      </div>

      <div className="text-sm text-muted-foreground">
        @{pull.user.login} · opened {relativeTime(pull.created_at)} · wants to
        merge{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">
          {pull.head.ref}
        </code>{" "}
        →{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">
          {pull.base.ref}
        </code>
      </div>

      {linked ? (
        <div className="text-sm text-muted-foreground">
          Linked issue:{" "}
          <Link
            to="/r/$owner/$repo/issues/$number"
            params={{ owner, repo, number: String(linked.number) }}
            className="font-medium text-foreground hover:underline"
          >
            #{linked.number}
          </Link>{" "}
          ({linked.state}) — {linked.title}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border bg-muted/30">
        {pull.body ? (
          <Markdown owner={owner} repo={repo} className="p-4">
            {pull.body}
          </Markdown>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No description.</p>
        )}
        <PullDevInfo owner={owner} repo={repo} number={pull.number} />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!pull.merged ? (
          <Button
            variant="secondary"
            disabled={setState.isPending}
            onClick={() =>
              setState.mutate(pull.state === "open" ? "closed" : "open")
            }
          >
            {setState.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            {pull.state === "open" ? "Close" : "Reopen"}
          </Button>
        ) : null}
        {canReady ? (
          <Button
            variant="secondary"
            disabled={ready.isPending}
            onClick={() => ready.mutate()}
          >
            {ready.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Mark ready for re-review
          </Button>
        ) : null}
        <select
          aria-label="Merge method"
          value={method}
          onChange={(e) => setMethod(e.target.value as MergeMethod)}
          disabled={!canMerge || merge.isPending}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {MERGE_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <Button
          disabled={!canMerge || merge.isPending}
          onClick={() => merge.mutate(method)}
        >
          {merge.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {pull.merged ? "Merged" : "Merge"}
        </Button>
      </div>

      {merge.isError ? (
        <p className="text-sm text-destructive">
          {merge.error instanceof Error
            ? `Merge failed: ${merge.error.message}`
            : "Merge failed."}
        </p>
      ) : null}
      {ready.isError ? (
        <p className="text-sm text-destructive">
          {ready.error instanceof Error
            ? `Update failed: ${ready.error.message}`
            : "Update failed."}
        </p>
      ) : null}
      {setState.isError ? (
        <p className="text-sm text-destructive">
          {setState.error instanceof Error
            ? `Update failed: ${setState.error.message}`
            : "Update failed."}
        </p>
      ) : null}
    </div>
  );
}

// dev.note kind → badge tone (reuses the existing badge palette; no new CSS).
const DEV_NOTE_TONE: Record<string, BadgeTone> = {
  decision: "open",
  action: "agent",
  assumption: "unknown",
  blocker: "conflict",
};

function DevNoteTimeline({
  owner,
  repo,
  notes,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  notes: DevNote[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  // Hide the section entirely until there is something to show, so PRs without a dev loop
  // (e.g. human-authored) stay uncluttered.
  if (!isLoading && !isError && (!notes || notes.length === 0)) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Dev notes</h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading dev notes…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load dev notes.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {(notes ?? []).map((n) => (
            <li key={n.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={DEV_NOTE_TONE[n.kind] ?? "unknown"}>
                  {n.kind}
                </Badge>
                <span className="font-medium">{n.summary}</span>
                <span className="text-xs text-muted-foreground">
                  @{n.actor} · {relativeTime(n.created_at)}
                </span>
              </div>
              {n.body ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Details
                  </summary>
                  <Markdown owner={owner} repo={repo} className="mt-1">
                    {n.body}
                  </Markdown>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const REVIEW_VERDICT_TONE: Record<PullReview["state"], string> = {
  APPROVE: "text-green-600 dark:text-green-400",
  REQUEST_CHANGES: "text-destructive",
  COMMENT: "text-muted-foreground",
};

function ReviewList({
  owner,
  repo,
  reviews,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  reviews: PullReview[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Reviews</h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading reviews…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load reviews.
        </div>
      ) : !reviews || reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviews.</p>
      ) : (
        reviews.map((r) => (
          <article key={r.id} className="rounded-md border p-3">
            <header className="mb-1 text-sm">
              <span className={`font-medium ${REVIEW_VERDICT_TONE[r.state]}`}>
                ● {r.state}
              </span>{" "}
              {r.topic ? (
                <span className="mr-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                  {r.topic}
                </span>
              ) : null}
              <span className="font-medium">@{r.user.login}</span>{" "}
              <span className="text-xs text-muted-foreground">
                {relativeTime(r.submitted_at)}
              </span>
            </header>
            {r.body ? (
              <Markdown owner={owner} repo={repo}>
                {r.body}
              </Markdown>
            ) : null}
          </article>
        ))
      )}
    </section>
  );
}

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-green-500/10 text-green-700 dark:text-green-300",
  del: "bg-red-500/10 text-red-700 dark:text-red-300",
  hunk: "bg-muted text-muted-foreground",
  meta: "text-muted-foreground",
  context: "",
};

function FilesChanged({
  owner,
  repo,
  files,
  lineComments,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  files: PullFile[] | undefined;
  lineComments: PullLineComment[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const byFile = new Map<string, PullLineComment[]>();
  for (const c of lineComments ?? []) {
    const list = byFile.get(c.path) ?? [];
    list.push(c);
    byFile.set(c.path, list);
  }

  // Whole-diff totals, summed from the per-file numstat already loaded here.
  const totalAdditions = files?.reduce((s, f) => s + f.additions, 0) ?? 0;
  const totalDeletions = files?.reduce((s, f) => s + f.deletions, 0) ?? 0;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
        Files changed{files ? ` (${files.length})` : ""}
        {files && files.length > 0 ? (
          <DiffStat
            additions={totalAdditions}
            deletions={totalDeletions}
            className="text-sm font-normal"
          />
        ) : null}
      </h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading diff…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load diff.
        </div>
      ) : !files || files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No diff.</p>
      ) : (
        files.map((f) => (
          <FileDiff
            key={f.filename}
            owner={owner}
            repo={repo}
            file={f}
            comments={byFile.get(f.filename) ?? []}
          />
        ))
      )}
    </section>
  );
}

function FileDiff({
  owner,
  repo,
  file,
  comments,
}: {
  owner: string;
  repo: string;
  file: PullFile;
  comments: PullLineComment[];
}) {
  const lines = parsePatch(file.patch);
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
        <span className="font-medium">{file.filename}</span>
        <span className="text-xs text-muted-foreground">
          +{file.additions} -{file.deletions}
        </span>
      </div>
      {lines.length > 0 ? (
        <pre className="overflow-x-auto text-xs leading-relaxed">
          {lines.map((l, i) => (
            <span key={i} className={`block px-3 ${DIFF_LINE_CLASS[l.kind]}`}>
              {l.text || " "}
            </span>
          ))}
        </pre>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No textual diff.
        </p>
      )}
      {comments.map((c) => (
        <div key={c.id} className="m-2 rounded-md border bg-muted/20 p-2">
          <div className="mb-1 text-xs">
            💬 @{c.user.login}{" "}
            <span className="text-muted-foreground">
              {c.path}:{c.line ?? "?"}
            </span>
          </div>
          <Markdown owner={owner} repo={repo}>
            {c.body}
          </Markdown>
        </div>
      ))}
    </div>
  );
}

function CommentList({
  owner,
  repo,
  comments,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  comments: import("@/api/types").IssueComment[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Comments</h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading comments…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load comments.
        </div>
      ) : !comments || comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments.</p>
      ) : (
        comments.map((c) => (
          <article key={c.id} className="rounded-md border p-3">
            <header className="mb-1 text-sm font-medium">
              @{c.user.login}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {relativeTime(c.created_at)}
              </span>
            </header>
            <Markdown owner={owner} repo={repo}>
              {c.body}
            </Markdown>
          </article>
        ))
      )}
    </section>
  );
}
