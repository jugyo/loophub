// PR-detail commit/review timeline: commits stay newest first, and each row owns the reviews made
// against that exact SHA. Reviews without a listed commit are omitted from the PR page.
// Commit selection, per-commit diff loading, and the GitHub push badge stay inside this component.
//
// Rubric grades (#1897) ride along with the reviews they belong to: the row summarizes them as
// pass / fail counts next to "Reviewed", and the review dialog lists each graded criterion with its
// note. Grades therefore inherit the commit grouping — a grade is only ever read against the SHA it
// was made on — and need no freshness state of their own.

import { Check, Loader2, UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PullLineComment, PullRequest, PullReview } from "@/api/types";
import { DiffLines } from "@/components/diff-lines";
import { DiffStat } from "@/components/diff-stat";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BadgeTone } from "@/lib/badges";
import { relativeTime } from "@/lib/time";
import { usePullCommitFiles } from "@/queries/pulls";

type PullCommit = NonNullable<PullRequest["commits"]>[number];
type SelectedReviewGroup = {
  label: string;
  reviews: PullReview[];
};

export function PullCommitsSection({
  owner,
  repo,
  number,
  commits = [],
  reviews = [],
  lineComments = [],
  isReviewsLoading,
  isReviewsError,
  showGithubPushState,
}: {
  owner: string;
  repo: string;
  number: number;
  commits: PullRequest["commits"];
  reviews: PullReview[] | undefined;
  lineComments: PullLineComment[] | undefined;
  isReviewsLoading: boolean;
  isReviewsError: boolean;
  showGithubPushState: boolean;
}) {
  const [selectedCommit, setSelectedCommit] = useState<PullCommit | null>(null);
  const [selectedReviewGroup, setSelectedReviewGroup] =
    useState<SelectedReviewGroup | null>(null);
  // Commits are newest first, so the topmost pushed one marks how far the GitHub branch reaches:
  // everything below it is pushed as well, and repeating the badge on those rows says nothing new
  // (#2039).
  const latestPushedSha = showGithubPushState
    ? (commits.find((commit) => commit.pushed_to_github)?.sha ?? null)
    : null;
  const commentsByReview = new Map<number, PullLineComment[]>();
  for (const comment of lineComments) {
    if (comment.pull_request_review_id == null) continue;
    const list = commentsByReview.get(comment.pull_request_review_id) ?? [];
    list.push(comment);
    commentsByReview.set(comment.pull_request_review_id, list);
  }
  return (
    <section
      data-debug-component="PullCommitsSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">Commits ({commits.length})</h2>
      {isReviewsLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading reviews…
        </div>
      ) : isReviewsError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load reviews.
        </div>
      ) : null}
      {commits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commits.</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-md border">
          {commits.map((commit) => {
            const commitReviews = reviews.filter(
              (review) => review.head_sha === commit.sha,
            );
            const shortSha = commit.sha.slice(0, 7);
            return (
              <li key={commit.sha} data-debug-component="PullCommitRow">
                <div className="flex min-w-0 items-center gap-3 px-3 py-2">
                  <button
                    type="button"
                    aria-label={`View changes in ${shortSha}: ${commit.subject}`}
                    className="flex min-w-0 flex-1 items-start gap-3 rounded text-left hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onClick={() => setSelectedCommit(commit)}
                  >
                    <code className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 text-xs">
                      {shortSha}
                    </code>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {commit.subject}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {commit.author} ·{" "}
                        <time dateTime={commit.date} title={commit.date}>
                          {relativeTime(commit.date)}
                        </time>
                      </div>
                    </div>
                  </button>
                  {!isReviewsLoading && !isReviewsError ? (
                    <CommitReviewStatus
                      reviews={commitReviews}
                      commentsByReview={commentsByReview}
                      label={`${shortSha}: ${commit.subject}`}
                      onOpen={() =>
                        setSelectedReviewGroup({
                          label: `${shortSha}: ${commit.subject}`,
                          reviews: commitReviews,
                        })
                      }
                    />
                  ) : null}
                  {commit.sha === latestPushedSha ? (
                    <Badge
                      tone="unknown"
                      title="Pushed to GitHub"
                      className="shrink-0 gap-1"
                    >
                      <UploadCloud className="size-3" />
                      Pushed
                    </Badge>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {selectedCommit ? (
        <CommitDiffDialog
          owner={owner}
          repo={repo}
          number={number}
          commit={selectedCommit}
          onClose={() => setSelectedCommit(null)}
        />
      ) : null}
      {selectedReviewGroup ? (
        <ReviewDetailsDialog
          owner={owner}
          repo={repo}
          label={selectedReviewGroup.label}
          reviews={selectedReviewGroup.reviews}
          commentsByReview={commentsByReview}
          onClose={() => setSelectedReviewGroup(null)}
        />
      ) : null}
    </section>
  );
}

const REVIEW_VERDICT_TONE: Record<string, string> = {
  PASS: "text-green-600 dark:text-green-400",
  REQUEST_CHANGES: "text-destructive",
  COMMENT: "text-muted-foreground",
};

function reviewGroupVerdict(reviews: PullReview[]): {
  tone: BadgeTone;
  label: string;
} {
  // reviews/list returns submitted_at ascending, matching computeReviewGate's latest-wins rule:
  // the last substantive review decides the verdict, and earlier ones no longer speak (#1934).
  let latest: PullReview | null = null;
  for (const review of reviews) {
    if (review.state === "PASS" || review.state === "REQUEST_CHANGES")
      latest = review;
  }
  if (latest?.state === "REQUEST_CHANGES") {
    return { tone: "review-changes", label: "changes requested" };
  }
  if (latest?.state === "PASS") {
    return { tone: "review-passed", label: "passed" };
  }
  return { tone: "review-commented", label: "commented" };
}

function CommitReviewStatus({
  reviews,
  commentsByReview,
  label,
  onOpen,
}: {
  reviews: PullReview[];
  commentsByReview: Map<number, PullLineComment[]>;
  label: string;
  onOpen: () => void;
}) {
  if (reviews.length === 0) {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">
        Not reviewed
      </span>
    );
  }
  const commentCount = reviews.reduce(
    (sum, review) => sum + (commentsByReview.get(review.id)?.length ?? 0),
    0,
  );
  return (
    <button
      type="button"
      aria-label={`View ${reviews.length} review${reviews.length === 1 ? "" : "s"} for ${label}`}
      className="flex shrink-0 items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
    >
      <span className="font-medium text-link">Reviewed</span>
      <ReviewVerdictSummary reviews={reviews} />
      <AcGradeCounts reviews={reviews} />
      {commentCount > 0 ? (
        <span className="text-muted-foreground">
          {commentCount} comment{commentCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </button>
  );
}

// How the rubric graded at this SHA, at a glance (#1897): passed / failed criterion counts over the
// group's reviews. Silent when nothing here graded structured criteria — a holistic review has no
// rubric to count, and the dialog says so per review.
function AcGradeCounts({ reviews }: { reviews: PullReview[] }) {
  const grades = reviews.flatMap((review) => review.ac_results);
  if (grades.length === 0) return null;
  const passed = grades.filter((grade) => grade.verdict === "pass").length;
  const failed = grades.length - passed;
  return (
    <span
      className="flex items-center gap-1.5"
      aria-label={`${passed} criteria passed, ${failed} failed`}
    >
      <span className="flex items-center gap-0.5 text-green-600 dark:text-green-400">
        <Check className="size-3.5" aria-hidden /> {passed}
      </span>
      <span className="flex items-center gap-0.5 text-destructive">
        <X className="size-3.5" aria-hidden /> {failed}
      </span>
    </span>
  );
}

function ReviewDetailsDialog({
  owner,
  repo,
  label,
  reviews,
  commentsByReview,
  onClose,
}: {
  owner: string;
  repo: string;
  label: string;
  reviews: PullReview[];
  commentsByReview: Map<number, PullLineComment[]>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnFocus = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        data-debug-component="ReviewDetailsDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Reviews for ${label}`}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-md border bg-background shadow-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          );
          if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
          }
          const currentIndex = focusable.indexOf(
            document.activeElement as HTMLElement,
          );
          const nextIndex = event.shiftKey
            ? (currentIndex - 1 + focusable.length) % focusable.length
            : (currentIndex + 1) % focusable.length;
          event.preventDefault();
          focusable[nextIndex]?.focus();
        }}
      >
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold">
              Reviews for {label}
            </h3>
            <ReviewVerdictSummary reviews={reviews} />
          </div>
          <Button
            ref={closeButtonRef}
            variant="secondary"
            size="sm"
            aria-label="Close reviews"
            className="h-7 w-7 shrink-0 p-0"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          {reviews.map((review) => (
            <ReviewItem
              key={review.id}
              owner={owner}
              repo={repo}
              review={review}
              comments={commentsByReview.get(review.id) ?? []}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewVerdictSummary({ reviews }: { reviews: PullReview[] }) {
  const verdict = reviewGroupVerdict(reviews);
  return (
    <>
      <Badge tone={verdict.tone}>{verdict.label}</Badge>
      {/* nowrap like the badge beside it: as a flex item this span otherwise shrinks to
          min-content and breaks between the count and "review(s)" (#1936). */}
      <span className="whitespace-nowrap text-xs font-normal text-muted-foreground">
        {reviews.length} review{reviews.length === 1 ? "" : "s"}
      </span>
    </>
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
    <article
      data-debug-component="ReviewItem"
      className="rounded-md border bg-background p-3"
    >
      <header className="mb-1 text-sm">
        <span
          className={`font-medium ${REVIEW_VERDICT_TONE[review.state] ?? "text-muted-foreground"}`}
        >
          ● {review.state}
        </span>{" "}
        <span className="font-medium">@{review.user.login}</span>{" "}
        {review.model ? (
          <span className="mr-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {review.model}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {relativeTime(review.submitted_at)}
        </span>
      </header>
      {review.body ? (
        <Markdown owner={owner} repo={repo}>
          {review.body}
        </Markdown>
      ) : null}
      <ReviewAcGrades review={review} />
      {comments.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {comments.map((comment) => (
            <li key={comment.id} className="rounded-md border bg-muted/20 p-2">
              <div className="mb-1 text-xs">
                💬 @{comment.user.login}{" "}
                <span className="text-muted-foreground">
                  {comment.path}:{comment.line ?? "?"}
                </span>
              </div>
              <Markdown owner={owner} repo={repo}>
                {comment.body}
              </Markdown>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

// The rubric grades this review recorded (#1897): each graded criterion with its pass / fail
// verdict and the grader's note. The wire already joins the criterion text via `criterion_id`
// (#1895), so this only renders. A review that graded no structured criteria — the holistic
// fallback taken when the linked issue has no structured AC — says so instead of showing an empty
// checklist.
function ReviewAcGrades({ review }: { review: PullReview }) {
  if (review.ac_results.length === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        No AC grading — this review graded no structured acceptance criteria.
      </p>
    );
  }
  return (
    <ul className="mt-2 flex flex-col gap-2 text-sm">
      {review.ac_results.map((result) => (
        <li key={result.criterion_id} className="flex items-start gap-2">
          {result.verdict === "pass" ? (
            <Check
              aria-label="pass"
              className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400"
            />
          ) : (
            <X
              aria-label="fail"
              className="mt-0.5 size-4 shrink-0 text-destructive"
            />
          )}
          <span className="flex min-w-0 flex-col gap-0.5 break-words">
            <span>
              <span className="mr-2 font-mono text-xs text-muted-foreground">
                AC {result.number}
              </span>
              {result.text}
            </span>
            {result.note ? (
              <span className="text-xs text-muted-foreground">
                {result.note}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CommitDiffDialog({
  owner,
  repo,
  number,
  commit,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  commit: PullCommit;
  onClose: () => void;
}) {
  const filesQuery = usePullCommitFiles(owner, repo, number, commit.sha);
  const shortSha = commit.sha.slice(0, 7);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/80 p-2 backdrop-blur-sm sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        data-debug-component="CommitDiffDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Changes in ${shortSha}: ${commit.subject}`}
        className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      >
        <header className="flex items-start justify-between gap-3 border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-xs">
              {shortSha}
            </code>
            <h3 className="truncate text-sm font-semibold">{commit.subject}</h3>
          </div>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Close commit diff"
            className="h-7 w-7 shrink-0 p-0"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {filesQuery.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading commit diff…
            </div>
          ) : filesQuery.isError ? (
            <div className="m-4 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              Failed to load commit diff.
              {filesQuery.error instanceof Error
                ? ` ${filesQuery.error.message}`
                : null}
            </div>
          ) : !filesQuery.data || filesQuery.data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No changes in this commit.
            </p>
          ) : (
            <div className="flex flex-col gap-3 p-3">
              {filesQuery.data.map((file) => (
                <article
                  key={file.filename}
                  data-debug-component="CommitDiffFile"
                  className="overflow-hidden rounded-md border"
                >
                  <header className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {file.filename}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {file.status}
                      </div>
                    </div>
                    <DiffStat
                      additions={file.additions}
                      deletions={file.deletions}
                      className="text-xs"
                    />
                  </header>
                  <div className="border-t">
                    <DiffLines patch={file.patch} />
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
