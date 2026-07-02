// PR detail view (/r/:owner/:repo/pulls/:number). v1 parity: title, body,
// state + review badges, head→base, the linked issue (bidirectional with the
// issue's linked PR), reviews, the file diff with line comments,
// issue comments, plus the write operations — merge (when PASSED), "mark ready
// for re-review" (when CHANGES_REQUESTED), and close/reopen (when not merged).
// Body, reviews, and comments are stored as plain Markdown and rendered as GFM
// via <Markdown>.

import { Link } from "@tanstack/react-router";
import { ChevronRight, ExternalLink, Github, Loader2 } from "lucide-react";
import { useState } from "react";
import type {
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
  ReviewNote,
} from "@/api/types";
import { DetailHeaderTitle } from "@/components/detail-title";
import { PullDevInfo } from "@/components/dev-info";
import { DiffStat } from "@/components/diff-stat";
import { useErrorBanner } from "@/components/error-banner";
import { HandoffTimeline } from "@/components/handoff-timeline";
import { Markdown } from "@/components/markdown";
import { MarkdownPreviewModal } from "@/components/markdown-preview-modal";
import { PullDebugMenu } from "@/components/pull-debug-menu";
import { RelatedSessions } from "@/components/related-sessions";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkDuration } from "@/components/work-duration";
import { type BadgeTone, pullDetailBadges } from "@/lib/badges";
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
  usePullHandoffs,
  usePullReviewNotes,
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
  const reviewNotesQuery = usePullReviewNotes(owner, repo, number);
  const handoffsQuery = usePullHandoffs(owner, repo, number);

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
  // The sidebar column is now always reserved (#456): WorkDuration always renders (with an "N/A"
  // fallback), so there is no longer a PR that leaves the aside empty. RelatedSessions and
  // HandoffTimeline still hide themselves individually when a PR has neither.

  return (
    // The whole PR detail is a two-column layout (#346): the main column (header, reviews, diff,
    // comments) on the left and the Sessions sidebar on the right, running alongside from the top
    // so ancillary info never interrupts the main vertical flow. Below `lg` the columns stack
    // (flex-col) so the sidebar wraps under the main content on narrow screens. The page widens to
    // `max-w-content-wide` only when the sidebar is present AND beside the content (`lg`); without a
    // sidebar, or while stacked below `lg`, the single column stays at the standard 60rem to line up
    // with the sibling pages (issue-detail, pull-list).
    <div className="mx-auto flex max-w-content flex-col gap-6 lg:max-w-content-wide lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {/* No key needed for feedback safety: operation-failure feedback now lives in the app-shell
            error banner (#323), which clears on route change, so a `Merge failed: …` error can no
            longer leak onto the next PR the way the inline mutation-observer error did (#321). */}
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
          lineComments={lineCommentsQuery.data}
          currentHeadSha={pull.head.sha}
          isLoading={reviewsQuery.isLoading}
          isError={reviewsQuery.isError}
        />

        <FilesChanged
          owner={owner}
          repo={repo}
          number={number}
          files={filesQuery.data}
          lineComments={lineCommentsQuery.data}
          reviewNotes={reviewNotesQuery.data}
          currentHeadSha={pull.head.sha}
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

      <aside className="flex w-full shrink-0 flex-col gap-6 lg:w-80">
        <WorkDuration workDuration={pull.work_duration} />
        <RelatedSessions
          owner={owner}
          repo={repo}
          sessions={pull.related_sessions}
          cwd={pull.worktree_path ?? undefined}
        />
        <HandoffTimeline
          owner={owner}
          repo={repo}
          handoffs={handoffsQuery.data}
          isLoading={handoffsQuery.isLoading}
          isError={handoffsQuery.isError}
        />
      </aside>
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
  const { showError } = useErrorBanner();
  const [method, setMethod] = useState<MergeMethod>("squash");

  // Shared with the built-in terminal header (terminal-pr-header.tsx) so the two
  // status lines always match (#386).
  const badges = pullDetailBadges(pull);
  const linked = pull.linked_issue;

  const canAct = pull.state === "open" && !pull.merged;
  // A conflicting PR (mergeable_state === "conflict", i.e. mergeable === false) can never merge
  // server-side, so the Merge control must stay disabled even when PASSED.
  const hasConflict = pull.mergeable_state === "conflict";
  // A draft PR is WIP (#413), so the Merge control stays disabled even if it somehow carries a
  // PASSED review — flip it to ready via "Mark ready for review" first.
  const canMerge =
    canAct && !pull.draft && pull.review_state === "PASSED" && !hasConflict;
  // "Ready for review" covers two transitions (#413): a draft PR (opened WIP by `lh dev`) becoming
  // ready, or an already-ready PR resubmitting after change requests. Draft takes precedence.
  const canReady =
    canAct && (pull.draft || pull.review_state === "CHANGES_REQUESTED");
  const mergeBlockedReason = hasConflict
    ? "Cannot merge: this PR has conflicts with the base branch."
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <DetailHeaderTitle kind="PR" number={pull.number} title={pull.title} />
        <PullDebugMenu owner={owner} repo={repo} number={pull.number} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {badges.map((b, i) => (
          <Badge key={`${b.tone}-${i}`} tone={b.tone} title={b.title}>
            {b.label}
          </Badge>
        ))}
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
              setState.mutate(pull.state === "open" ? "closed" : "open", {
                onError: (e) => showError(failureMessage("Update failed", e)),
              })
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
            onClick={() =>
              ready.mutate(undefined, {
                onError: (e) => showError(failureMessage("Update failed", e)),
              })
            }
          >
            {ready.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            {pull.draft ? "Mark ready for review" : "Mark ready for re-review"}
          </Button>
        ) : null}
        {/* #406: the repo's effective merge mode picks exactly one write action — the internal Merge
            control, or the GitHub export (Create / View PR on GitHub). The two are mutually
            exclusive, so a merged PR shows neither extra control beyond Close/Reopen above. */}
        {pull.merge_mode === "github_pr" ? (
          <GithubPrAction owner={owner} repo={repo} pull={pull} />
        ) : (
          <>
            <select
              aria-label="Merge method"
              value={method}
              onChange={(e) => setMethod(e.target.value as MergeMethod)}
              disabled={!canMerge || merge.isPending}
              title={mergeBlockedReason}
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
              title={mergeBlockedReason}
              onClick={() =>
                merge.mutate(method, {
                  onError: (e) => showError(failureMessage("Merge failed", e)),
                })
              }
            >
              {merge.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {pull.merged ? "Merged" : "Merge"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// #406: GitHub-export write action for a PR whose repo is in 'github_pr' mode. Once the PR has been
// exported (github_pull present) the button becomes a "View PR on GitHub" link — this is the
// double-create guard: the Create action disappears so a second export can't be dispatched. Until
// then, "Create PR on GitHub" dispatches the export skill into a terminal (same pattern as the
// issue Build button), where the skill generates a branch/title/description and opens the draft PR.
// The skill itself ships separately (issue #406 part B); the slash command below is the seam.
function GithubPrAction({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const gh = pull.github_pull;
  if (gh) {
    return (
      <a
        href={gh.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`GitHub PR #${gh.number}`}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted"
      >
        <Github className="size-4" />
        View PR on GitHub
        <ExternalLink className="size-3.5 text-muted-foreground" />
      </a>
    );
  }
  // A merged or closed loophub PR is past the point of exporting, so offer Create only while open.
  if (pull.state !== "open" || pull.merged) return null;
  return (
    <Button
      title="Create a PR on GitHub from this branch via the export skill"
      onClick={() =>
        launchTerminal({
          command: `claude "/create-github-pr ${pull.number}"`,
          repo: `${owner}/${repo}`,
          label: `PR #${pull.number} - ${pull.title}`,
          workflow: "github-pr-export",
          prNumber: pull.number,
        })
      }
    >
      <Github className="size-4" />
      Create PR on GitHub
    </Button>
  );
}

// Format a mutation failure for the error banner: `"<prefix>: <message>"` when the error carries a
// message, else `"<prefix>."`. Mirrors the wording the inline isError blocks used before #323.
function failureMessage(prefix: string, error: unknown): string {
  return error instanceof Error ? `${prefix}: ${error.message}` : `${prefix}.`;
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
  PASS: "text-green-600 dark:text-green-400",
  REQUEST_CHANGES: "text-destructive",
  COMMENT: "text-muted-foreground",
};

type ReviewGroup = {
  /** The commit (head_sha) the reviews were made against; null for legacy reviews. */
  headSha: string | null;
  reviews: PullReview[];
  /** Whether this group targets the PR's current head commit. */
  isCurrent: boolean;
};

// Collapse a group's reviews into a single verdict shown on the (always-visible)
// summary, so a reader sees each group's state without expanding it (#268).
// Mirrors core/store.ts's computeReviewGate: only the latest review per topic
// counts, so a REQUEST_CHANGES that a later PASS on the same topic resolves no
// longer dominates the verdict (#533). Reviews arrive in created_at ASC order
// (see groupReviewsByCommit), so the last write per topic wins.
function reviewGroupVerdict(reviews: PullReview[]): {
  tone: BadgeTone;
  label: string;
} {
  const latestByTopic = new Map<string | null, PullReview>();
  for (const r of reviews) {
    if (r.state === "PASS" || r.state === "REQUEST_CHANGES")
      latestByTopic.set(r.topic ?? null, r);
  }
  const latest = [...latestByTopic.values()];
  if (latest.some((r) => r.state === "REQUEST_CHANGES"))
    return { tone: "review-changes", label: "changes requested" };
  if (latest.some((r) => r.state === "PASS"))
    return { tone: "review-passed", label: "passed" };
  return { tone: "review-commented", label: "commented" };
}

// Group reviews by the commit (head_sha) they were made against. The group for
// the PR's current head comes first; the remaining groups follow
// newest-review-first. Every group renders collapsed by default (#268) — the
// summary carries the verdict (see {@link reviewGroupVerdict}) so the state is
// visible without expanding.
function groupReviewsByCommit(
  reviews: PullReview[],
  currentHeadSha: string,
): ReviewGroup[] {
  const byCommit = new Map<string, PullReview[]>();
  for (const r of reviews) {
    const key = r.head_sha ?? "";
    const list = byCommit.get(key) ?? [];
    list.push(r);
    byCommit.set(key, list);
  }
  const groups: ReviewGroup[] = [];
  for (const [key, list] of byCommit) {
    groups.push({
      headSha: key === "" ? null : key,
      reviews: list,
      isCurrent: key !== "" && key === currentHeadSha,
    });
  }
  // Max submitted_at in the group; computed explicitly so the non-current
  // group ordering does not depend on the backend's row order.
  const latest = (g: ReviewGroup) =>
    g.reviews.reduce((m, r) => (r.submitted_at > m ? r.submitted_at : m), "");
  groups.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return latest(b).localeCompare(latest(a));
  });
  return groups;
}

function ReviewList({
  owner,
  repo,
  reviews,
  lineComments,
  currentHeadSha,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  reviews: PullReview[] | undefined;
  lineComments: PullLineComment[] | undefined;
  currentHeadSha: string;
  isLoading: boolean;
  isError: boolean;
}) {
  // Inline comments keyed by the review they belong to, so each review shows its
  // own line comments inside its commit group (collapsing with the group).
  const commentsByReview = new Map<number, PullLineComment[]>();
  for (const c of lineComments ?? []) {
    if (c.pull_request_review_id == null) continue;
    const list = commentsByReview.get(c.pull_request_review_id) ?? [];
    list.push(c);
    commentsByReview.set(c.pull_request_review_id, list);
  }

  const groups =
    reviews && reviews.length > 0
      ? groupReviewsByCommit(reviews, currentHeadSha)
      : [];

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
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviews.</p>
      ) : (
        groups.map((g) => (
          <ReviewCommitGroup
            key={g.headSha ?? "unknown"}
            owner={owner}
            repo={repo}
            group={g}
            commentsByReview={commentsByReview}
          />
        ))
      )}
    </section>
  );
}

function ReviewCommitGroup({
  owner,
  repo,
  group,
  commentsByReview,
}: {
  owner: string;
  repo: string;
  group: ReviewGroup;
  commentsByReview: Map<number, PullLineComment[]>;
}) {
  const shortSha = group.headSha ? group.headSha.slice(0, 7) : null;
  const count = group.reviews.length;
  const verdict = reviewGroupVerdict(group.reviews);
  return (
    <details className="group overflow-hidden rounded-md border">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 bg-muted/40 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden list-none">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        {shortSha ? (
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {shortSha}
          </code>
        ) : (
          <span className="font-medium">unknown commit</span>
        )}
        {group.isCurrent ? (
          <Badge tone="open">current</Badge>
        ) : group.headSha ? (
          <Badge tone="review-rereview">STALE</Badge>
        ) : null}
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        <span className="text-xs text-muted-foreground">
          {count} review{count === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="flex flex-col gap-3 p-3">
        {group.reviews.map((r) => (
          <ReviewItem
            key={r.id}
            owner={owner}
            repo={repo}
            review={r}
            comments={commentsByReview.get(r.id) ?? []}
          />
        ))}
      </div>
    </details>
  );
}

function ReviewItem({
  owner,
  repo,
  review,
  comments,
}: {
  owner: string;
  repo: string;
  review: PullReview;
  comments: PullLineComment[];
}) {
  return (
    <article className="rounded-md border p-3">
      <header className="mb-1 text-sm">
        <span className={`font-medium ${REVIEW_VERDICT_TONE[review.state]}`}>
          ● {review.state}
        </span>{" "}
        {review.topic ? (
          <span className="mr-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {review.topic}
          </span>
        ) : null}
        <span className="font-medium">@{review.user.login}</span>{" "}
        <span className="text-xs text-muted-foreground">
          {relativeTime(review.submitted_at)}
        </span>
      </header>
      {review.body ? (
        <Markdown owner={owner} repo={repo}>
          {review.body}
        </Markdown>
      ) : null}
      {comments.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md border bg-muted/20 p-2">
              <div className="mb-1 text-xs">
                💬 @{c.user.login}{" "}
                <span className="text-muted-foreground">
                  {c.path}:{c.line ?? "?"}
                </span>
              </div>
              <Markdown owner={owner} repo={repo}>
                {c.body}
              </Markdown>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
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
  number,
  files,
  lineComments,
  reviewNotes,
  currentHeadSha,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  number: number;
  files: PullFile[] | undefined;
  lineComments: PullLineComment[] | undefined;
  reviewNotes: ReviewNote[] | undefined;
  currentHeadSha: string;
  isLoading: boolean;
  isError: boolean;
}) {
  const byFile = new Map<string, PullLineComment[]>();
  for (const c of lineComments ?? []) {
    const list = byFile.get(c.path) ?? [];
    list.push(c);
    byFile.set(c.path, list);
  }

  // Review notes grouped by path so each file diff shows its own note(s). Guarded against a
  // non-array (the RPC mock returns {} for unstubbed methods).
  const notesByFile = new Map<string, ReviewNote[]>();
  for (const n of Array.isArray(reviewNotes) ? reviewNotes : []) {
    const list = notesByFile.get(n.path) ?? [];
    list.push(n);
    notesByFile.set(n.path, list);
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
            number={number}
            file={f}
            comments={byFile.get(f.filename) ?? []}
            notes={notesByFile.get(f.filename) ?? []}
            currentHeadSha={currentHeadSha}
          />
        ))
      )}
    </section>
  );
}

// Files changed only shows the unified diff patch, not a rendered whole-file view — Preview
// opens a full-size modal with the base/head Markdown instead (#435). Scoped to .md/.markdown so
// non-Markdown files (which the modal can't usefully render) don't grow the button.
const MARKDOWN_FILENAME = /\.(md|markdown)$/i;

// `file.filename` for a rename comes from git numstat's mangled "old => new" / "dir/{old =>
// new}" path column (core/git.ts diffFiles), not a real path — `git show <ref>:<path>` can't
// resolve it. Exclude renamed files from Preview rather than resolving the wrong or a missing
// blob (fixing this properly needs diffFiles() to expose the real per-side rename paths, which
// is out of scope here).
const RENAMED_FILENAME = / => /;

function FileDiff({
  owner,
  repo,
  number,
  file,
  comments,
  notes,
  currentHeadSha,
}: {
  owner: string;
  repo: string;
  number: number;
  file: PullFile;
  comments: PullLineComment[];
  notes: ReviewNote[];
  currentHeadSha: string;
}) {
  const lines = parsePatch(file.patch);
  const [previewOpen, setPreviewOpen] = useState(false);
  const isMarkdown =
    MARKDOWN_FILENAME.test(file.filename) &&
    !RENAMED_FILENAME.test(file.filename);
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
        <span className="font-medium">{file.filename}</span>
        <span className="text-xs text-muted-foreground">
          +{file.additions} -{file.deletions}
        </span>
        {isMarkdown ? (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            onClick={() => setPreviewOpen(true)}
          >
            Preview
          </Button>
        ) : null}
      </div>
      {previewOpen ? (
        <MarkdownPreviewModal
          owner={owner}
          repo={repo}
          number={number}
          path={file.filename}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
      {notes.map((n) => (
        <ReviewNoteCard
          key={n.id}
          owner={owner}
          repo={repo}
          note={n}
          currentHeadSha={currentHeadSha}
        />
      ))}
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

// A per-file review note (#217): the factual "role / change summary / review points" for a
// file's diff range, shown in-flow above the patch so reviewers read it as they read the diff.
// The range (base→commit) is shown as short SHAs; a note whose commit_sha no longer matches the
// PR's current head is marked STALE so a reviewer knows it describes an earlier commit.
function ReviewNoteCard({
  owner,
  repo,
  note,
  currentHeadSha,
}: {
  owner: string;
  repo: string;
  note: ReviewNote;
  currentHeadSha: string;
}) {
  const isStale = !!currentHeadSha && note.commit_sha !== currentHeadSha;
  return (
    <div className="m-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-sky-700 dark:text-sky-300">
          📝 Note
        </span>
        <code className="rounded bg-muted px-1 py-0.5">
          {note.base_sha.slice(0, 7)}…{note.commit_sha.slice(0, 7)}
        </code>
        {isStale ? (
          <Badge tone="review-rereview">STALE</Badge>
        ) : (
          <Badge tone="open">current</Badge>
        )}
        <span className="text-muted-foreground">
          @{note.user.login} · {relativeTime(note.created_at)}
        </span>
      </div>
      <Markdown owner={owner} repo={repo}>
        {note.body}
      </Markdown>
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
