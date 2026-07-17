// PR detail view (/r/:owner/:repo/pulls/:number). v1 parity: title, body,
// state + review badges, head→base, the linked issue (bidirectional with the
// issue's linked PR), reviews, the file diff with line comments,
// issue comments, plus the write operations — merge (when PASSED), "mark ready
// for re-review" (when CHANGES_REQUESTED), and close/reopen (when not merged).
// Body, reviews, and comments are stored as plain Markdown and rendered as GFM
// via <Markdown>.

import { Link } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Github,
  Loader2,
  UploadCloud,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type {
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
} from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { DetailHeaderTitle } from "@/components/detail-title";
import { DiffStat } from "@/components/diff-stat";
import { GithubPrStatusSection } from "@/components/github-pr-status";
import { Markdown } from "@/components/markdown";
import { PullDebugMenu } from "@/components/pull-debug-menu";
import { PullHerdrSection } from "@/components/pull-herdr-section";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button, disabledButtonStateClasses } from "@/components/ui/button";
import { WorkDuration } from "@/components/work-duration";
import { WorkflowRunStatusSection } from "@/components/workflow-run-status";
import { type BadgeTone, pullDetailBadges } from "@/lib/badges";
import { type DiffLineKind, parsePatch } from "@/lib/diff";
import { usePageTitle } from "@/lib/page-title";
import { relativeTime } from "@/lib/time";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { cn } from "@/lib/utils";
import { useIssueComments } from "@/queries/issues";
import {
  useGithubPrStatus,
  useMergePull,
  usePull,
  usePullComments,
  usePullCommitFiles,
  usePullFileAtRef,
  usePullFiles,
  usePullReviews,
  usePushGithubPull,
  useReadyForReview,
  useSetPullState,
} from "@/queries/pulls";
import { useWorkflowRunForPull } from "@/queries/workflow-runs";

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
  // Only fetch GitHub status once the PR is known to have a linked GitHub PR — the endpoint 404s
  // otherwise, and the sidebar section is hidden anyway when github_pull is absent (#850).
  const githubStatusQuery = useGithubPrStatus(
    owner,
    repo,
    number,
    !!pullQuery.data?.github_pull,
  );

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
  // fallback), so there is no longer a PR that leaves the aside empty. Other sidebar sections
  // (Herdr, workflow run, GitHub PR status) hide themselves individually when empty.

  return (
    // The whole PR detail is a two-column layout (#346): the main column (header, reviews, diff,
    // comments) on the left and the Sessions sidebar on the right, running alongside from the top
    // so ancillary info never interrupts the main vertical flow. Below `lg` the columns stack
    // (flex-col) so the sidebar wraps under the main content on narrow screens. The page widens to
    // `max-w-content-wide` only when the sidebar is present AND beside the content (`lg`); without a
    // sidebar, or while stacked below `lg`, the single column stays at the standard 60rem to line up
    // with the sibling pages (issue-detail, pull-list).
    <div
      data-debug-component="PullDetail"
      className="mx-auto flex max-w-content flex-col gap-6 lg:max-w-content-wide lg:flex-row lg:items-start"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {/* No key needed for feedback safety: operation-failure feedback now lives in the app-shell
            error banner (#323), which clears on route change, so a `Merge failed: …` error can no
            longer leak onto the next PR the way the inline mutation-observer error did (#321). */}
        <PullHeader owner={owner} repo={repo} pull={pull} />

        <CommitList
          owner={owner}
          repo={repo}
          number={number}
          commits={pull.commits}
          showGithubPushState={!!pull.github_pull}
        />
        <FilesChanged
          owner={owner}
          repo={repo}
          number={number}
          files={filesQuery.data}
          lineComments={lineCommentsQuery.data}
          isLoading={filesQuery.isLoading}
          isError={filesQuery.isError}
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

        <CommentList
          owner={owner}
          repo={repo}
          comments={commentsQuery.data}
          isLoading={commentsQuery.isLoading}
          isError={commentsQuery.isError}
        />
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-6 lg:w-80">
        <PullHerdrSection owner={owner} repo={repo} pull={number} />
        <WorkflowRunSection owner={owner} repo={repo} number={number} />
        <WorktreeSection value={pull.worktree_path} />
        {/* GitHub PR status (#850): only for a PR with a linked GitHub PR. Fetched on demand;
            loading/error live in the section. */}
        {pull.github_pull ? (
          <GithubPrStatusSection
            status={githubStatusQuery.data}
            isLoading={githubStatusQuery.isLoading}
          />
        ) : null}
        {/* Work duration sits at the bottom of the sidebar (#627): a low-priority historical
            summary that ranks below the live Agents and Workflow run state above. */}
        <WorkDuration workDuration={pull.work_duration} />
      </aside>
    </div>
  );
}

type PullCommit = NonNullable<PullRequest["commits"]>[number];

function CommitList({
  owner,
  repo,
  number,
  commits = [],
  showGithubPushState,
}: {
  owner: string;
  repo: string;
  number: number;
  commits: PullRequest["commits"];
  showGithubPushState: boolean;
}) {
  const [selectedCommit, setSelectedCommit] = useState<PullCommit | null>(null);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Commits ({commits.length})</h2>
      {commits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commits.</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-md border">
          {commits.map((commit) => (
            <li key={commit.sha}>
              <button
                type="button"
                aria-label={`View changes in ${commit.sha.slice(0, 7)}: ${commit.subject}`}
                className="flex w-full min-w-0 items-start gap-3 px-3 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => setSelectedCommit(commit)}
              >
                <code className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 text-xs">
                  {commit.sha.slice(0, 7)}
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
                {showGithubPushState && commit.pushed_to_github ? (
                  <Badge
                    tone="unknown"
                    title="Pushed to GitHub"
                    className="mt-0.5 shrink-0 gap-1"
                  >
                    <UploadCloud className="size-3" />
                    Pushed
                  </Badge>
                ) : null}
              </button>
            </li>
          ))}
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
    </section>
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
                    <FileDiffContent
                      owner={owner}
                      repo={repo}
                      number={number}
                      file={file}
                      comments={[]}
                      mode="diff"
                    />
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

// Workflow run state for this PR (#1008): renders the linked run's status / step / rework via the
// shared section, or nothing when the PR has no run.
function WorkflowRunSection({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const query = useWorkflowRunForPull(owner, repo, number);
  if (query.isLoading) {
    return (
      <section
        data-debug-component="WorkflowRunSection"
        className="flex flex-col gap-3"
      >
        <h2 className="text-sm font-medium text-muted-foreground">
          Workflow run
        </h2>
        <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading Workflow run…
        </div>
      </section>
    );
  }
  if (query.isError) {
    return (
      <section
        data-debug-component="WorkflowRunSection"
        className="flex flex-col gap-3"
      >
        <h2 className="text-sm font-medium text-muted-foreground">
          Workflow run
        </h2>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          Failed to load Workflow run.
        </div>
      </section>
    );
  }
  return (
    <WorkflowRunStatusSection
      owner={owner}
      repo={repo}
      state={query.data}
      showHistory
    />
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
  const { showError } = useToast();
  usePageTitle([`${owner}/${repo}`, `PR #${pull.number}`, pull.title]);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [isMergeLoading, startMergeLoading] = useFixedLoading();
  // The fixed loading window is a UX minimum, not a substitute for the real request: once it
  // elapses the button must stay disabled/spinning until the mutation itself settles, so a
  // slow merge can't be double-submitted (#560).
  const isMerging = isMergeLoading || merge.isPending;

  const badges = pullDetailBadges(pull);
  const linked = pull.linked_issue;
  const isWorkflowAuthor = /^Workflow #\d+\b/.test(pull.user.login);

  const canAct = pull.state === "open" && !pull.merged;
  // A conflicting PR (mergeable_state === "conflict", i.e. mergeable === false) can never merge
  // server-side, so the Merge control must stay disabled even when PASSED.
  const hasConflict = pull.mergeable_state === "conflict";
  // A PR with no commits has nothing to merge server-side either (#691), so the Merge control
  // must stay disabled the same way a conflict does.
  const hasNoCommits = pull.mergeable_state === "no_commits";
  // A draft PR is WIP (#413), so the Merge control stays disabled even if it somehow carries a
  // PASSED review — flip it to ready via "Mark ready for review" first.
  const canMerge =
    canAct &&
    !pull.draft &&
    pull.review_state === "PASSED" &&
    !hasConflict &&
    !hasNoCommits;
  // "Ready for review" covers two transitions (#413): a draft PR (opened WIP by `lh build`) becoming
  // ready, or an already-ready PR resubmitting after change requests. Draft takes precedence.
  const canReady =
    canAct && (pull.draft || pull.review_state === "CHANGES_REQUESTED");
  const mergeBlockedReason = hasConflict
    ? "Cannot merge: this PR has conflicts with the base branch."
    : hasNoCommits
      ? "Cannot merge: this PR has no commits."
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
        {isWorkflowAuthor ? null : <>@{pull.user.login} · </>}opened{" "}
        {relativeTime(pull.created_at)} · wants to merge{" "}
        <span className="inline-flex items-center gap-1 align-middle">
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {pull.head.ref}
          </code>
          <CopyButton
            value={pull.head.ref}
            label={`Copy branch name: ${pull.head.ref}`}
            className="size-6"
          />
        </span>{" "}
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

      <div className="rounded-md border bg-muted/30">
        {pull.body ? (
          <Markdown owner={owner} repo={repo} className="p-4">
            {pull.body}
          </Markdown>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No description.</p>
        )}
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
              disabled={!canMerge || isMerging}
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
              disabled={!canMerge || isMerging}
              title={mergeBlockedReason}
              onClick={() => {
                startMergeLoading();
                merge.mutate(method, {
                  onError: (e) => showError(failureMessage("Merge failed", e)),
                });
              }}
            >
              {isMerging ? <Loader2 className="size-4 animate-spin" /> : null}
              {pull.merged ? "Merged" : "Merge"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function WorktreeSection({ value }: { value: string | null }) {
  return (
    <section
      data-debug-component="WorktreeSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">Worktree</h2>
      {value ? (
        <div className="flex items-start gap-2 rounded-md border p-3 text-sm">
          <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 text-xs">
            {value}
          </code>
          <CopyButton value={value} label="Copy worktree path" />
        </div>
      ) : (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          Unavailable
        </p>
      )}
    </section>
  );
}

// Review with Crit (#1578 / #1594): fire-and-forget herdr pane running `lh pr crit <n>`.
// Lives on the Files changed header row (right-aligned). Worktree absence and a missing crit
// binary surface as visible errors inside that pane — no defensive pre-checks here.
function CritReviewAction({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const { launchTerminal } = useTerminalLauncher();
  return (
    <Button
      variant="secondary"
      title="Open crit against this PR's worktree in a new Herdr pane"
      onClick={() =>
        launchTerminal({
          repo: `${owner}/${repo}`,
          label: `crit PR #${number}`,
          workflow: "pr-crit",
          prNumber: number,
        })
      }
    >
      Review with Crit
    </Button>
  );
}

// #406: GitHub-export write action for a PR whose repo is in 'github_pr' mode. Once the PR has been
// exported (github_pull present) the button becomes a "View PR on GitHub" link — this is the
// double-create guard: the Create action disappears so a second export can't be dispatched. Until
// then, "Create PR on GitHub" dispatches the export skill into a terminal (same pattern as the
// issue Build button), where the skill generates a branch/title/description and opens the draft PR.
// The skill itself ships separately (issue #406 part B); the workflow launch maps to
// /lh-create-github-pr in core/terminal/terminal-launch.ts.
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
  const { showError } = useToast();

  // #848: push local changes to the linked GitHub PR's branch. isPending drives the disabled +
  // spinner state so the click can't fire twice (AC4).
  const pushChanges = usePushGithubPull(owner, repo, pull.number);

  const gh = pull.github_pull;
  if (gh) {
    // Unpushed local changes exist when we know what was last pushed (pushed_sha) and the PR's head
    // has moved past it. Gated on an open, unmerged PR and a recorded branch to push onto — a
    // closed/merged PR is past syncing (AC7), and a null pushed_sha (e.g. an externally-attached PR
    // never pushed from here) reads as "nothing known to be unpushed", so the button stays disabled.
    const hasUnpushedChanges =
      pull.state === "open" &&
      !pull.merged &&
      !!gh.branch &&
      !!gh.pushed_sha &&
      !!pull.head.sha &&
      pull.head.sha !== gh.pushed_sha;
    return (
      <>
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
        <Button
          variant="secondary"
          disabled={!hasUnpushedChanges || pushChanges.isPending}
          title={
            hasUnpushedChanges
              ? `Push local changes to the GitHub PR branch (${gh.branch})`
              : "No local changes to push to GitHub"
          }
          onClick={() =>
            pushChanges.mutate(undefined, {
              onError: (e) =>
                showError(failureMessage("Push to GitHub failed", e)),
            })
          }
        >
          {pushChanges.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <UploadCloud className="size-4" />
          )}
          {pushChanges.isPending ? "Pushing…" : "Push to GitHub"}
        </Button>
      </>
    );
  }
  // A merged or closed loophub PR is past the point of exporting, so offer Create only while open.
  if (pull.state !== "open" || pull.merged) return null;
  return (
    <Button
      title="Create a PR on GitHub from this branch via the export skill"
      onClick={() =>
        launchTerminal({
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
  currentHeadSha: string | null,
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
  currentHeadSha: string | null;
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
          <Badge className="text-foreground">current</Badge>
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
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  number: number;
  files: PullFile[] | undefined;
  lineComments: PullLineComment[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const [openFilename, setOpenFilename] = useState<string | null>(null);
  const openFile = files?.find((f) => f.filename === openFilename) ?? null;
  const openFileIndex =
    openFilename && files
      ? files.findIndex((f) => f.filename === openFilename)
      : -1;
  const hasPreviousFile = openFileIndex > 0;
  const hasNextFile = Boolean(
    files && openFileIndex >= 0 && openFileIndex < files.length - 1,
  );
  useEffect(() => {
    if (openFilename && files && !openFile) setOpenFilename(null);
  }, [files, openFile, openFilename]);

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
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <CritReviewAction owner={owner} repo={repo} number={number} />
      </div>
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
        <>
          <div className="overflow-hidden rounded-md border">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b bg-muted/40 px-2.5 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <span>File</span>
              <span>Changes</span>
            </div>
            <ul className="divide-y">
              {files.map((f) => (
                <FileSummaryRow
                  key={f.filename}
                  file={f}
                  onOpen={() => setOpenFilename(f.filename)}
                />
              ))}
            </ul>
          </div>
          {openFile ? (
            <DiffFileDialog
              owner={owner}
              repo={repo}
              number={number}
              file={openFile}
              comments={byFile.get(openFile.filename) ?? []}
              hasPreviousFile={hasPreviousFile}
              hasNextFile={hasNextFile}
              onPreviousFile={() => {
                if (files && hasPreviousFile) {
                  setOpenFilename(files[openFileIndex - 1].filename);
                }
              }}
              onNextFile={() => {
                if (files && hasNextFile) {
                  setOpenFilename(files[openFileIndex + 1].filename);
                }
              }}
              onClose={() => setOpenFilename(null)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function FileSummaryRow({
  file,
  onOpen,
}: {
  file: PullFile;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2.5 py-1.5 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{file.filename}</span>
          <span className="text-[11px] text-muted-foreground">
            {file.status}
          </span>
        </span>
        <DiffStat
          additions={file.additions}
          deletions={file.deletions}
          className="text-xs"
        />
      </button>
    </li>
  );
}

// Markdown files can also switch the same diff dialog to base/head rendered previews.
const MARKDOWN_FILENAME = /\.(md|markdown)$/i;

// `file.filename` for a rename is git numstat's display label ("old => new" / "dir/{old =>
// new}"), not a real path. The copy button can use `headFilename`, but the Markdown Preview
// path still points at `file.filename`, so keep previews off for synthetic rename labels.
const RENAMED_FILENAME = / => /;

function isSyntheticRenameFilename(file: PullFile) {
  return (
    file.status === "renamed" ||
    (RENAMED_FILENAME.test(file.filename) && !file.patch?.trim())
  );
}

function renameTargetPath(filename: string) {
  const braced = /^(.*)\{(.+) => (.+)\}(.*)$/.exec(filename);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`;
  const direct = /^.+ => (.+)$/.exec(filename);
  return direct?.[1] ?? null;
}

function copyFilename(file: PullFile) {
  if (file.headFilename) return file.headFilename;
  if (isSyntheticRenameFilename(file)) {
    return renameTargetPath(file.filename) ?? file.filename;
  }
  return file.filename;
}

const UNSAFE_COPY_PATH_CHAR = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/u;

function visibleCopyPath(path: string) {
  if (!UNSAFE_COPY_PATH_CHAR.test(path)) return path;
  return Array.from(path, (char) => {
    if (!UNSAFE_COPY_PATH_CHAR.test(char)) return char;
    switch (char) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default: {
        const codePoint = char.codePointAt(0) ?? 0;
        return codePoint > 0xffff
          ? `\\u{${codePoint.toString(16)}}`
          : `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
    }
  }).join("");
}

type DiffDialogMode = "diff" | "raw" | "base" | "head";

function DiffFileDialog({
  owner,
  repo,
  number,
  file,
  comments,
  hasPreviousFile,
  hasNextFile,
  onPreviousFile,
  onNextFile,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  file: PullFile;
  comments: PullLineComment[];
  hasPreviousFile: boolean;
  hasNextFile: boolean;
  onPreviousFile: () => void;
  onNextFile: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<DiffDialogMode>("diff");
  const copyPath = visibleCopyPath(copyFilename(file));
  const isMarkdown =
    MARKDOWN_FILENAME.test(file.filename) && !isSyntheticRenameFilename(file);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    setMode("diff");
  }, [file.filename]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/80 p-2 backdrop-blur-sm sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Diff for ${file.filename}`}
        className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1">
              <h3 className="min-w-0 truncate text-sm font-semibold">
                {file.filename}
              </h3>
              <CopyButton
                key={copyPath}
                value={copyPath}
                label={`Copy file path: ${copyPath}`}
                className="size-6"
              />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>{file.status}</span>
              <DiffStat additions={file.additions} deletions={file.deletions} />
            </div>
          </div>
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
            <div className="flex overflow-hidden rounded-md border text-xs">
              <ModeButton
                active={mode === "diff"}
                onClick={() => setMode("diff")}
              >
                Diff
              </ModeButton>
              <ModeButton
                active={mode === "raw"}
                onClick={() => setMode("raw")}
              >
                Raw
              </ModeButton>
              {isMarkdown ? (
                <>
                  <ModeButton
                    active={mode === "base"}
                    onClick={() => setMode("base")}
                  >
                    Base
                  </ModeButton>
                  <ModeButton
                    active={mode === "head"}
                    onClick={() => setMode("head")}
                  >
                    Head
                  </ModeButton>
                </>
              ) : null}
            </div>
            <div className="flex overflow-hidden rounded-md border text-xs">
              <ModeButton disabled={!hasPreviousFile} onClick={onPreviousFile}>
                <ChevronLeft className="size-3" />
                Prev
              </ModeButton>
              <ModeButton disabled={!hasNextFile} onClick={onNextFile}>
                Next
                <ChevronRight className="size-3" />
              </ModeButton>
            </div>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Close diff"
              className="h-7 w-7 shrink-0 p-0"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <FileDiffContent
            owner={owner}
            repo={repo}
            number={number}
            file={file}
            comments={comments}
            mode={mode}
          />
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  disabled = false,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active ?? undefined}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1 px-2.5 py-1 transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        disabled && disabledButtonStateClasses,
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FileDiffContent({
  owner,
  repo,
  number,
  file,
  comments,
  mode,
}: {
  owner: string;
  repo: string;
  number: number;
  file: PullFile;
  comments: PullLineComment[];
  mode: DiffDialogMode;
}) {
  const lines = parsePatch(file.patch);
  if (mode === "raw") {
    return (
      <RawFilePane
        owner={owner}
        repo={repo}
        number={number}
        path={copyFilename(file)}
        side={file.status === "removed" ? "base" : "head"}
      />
    );
  }
  if (mode === "base" || mode === "head") {
    return (
      <MarkdownPreviewPane
        owner={owner}
        repo={repo}
        number={number}
        path={file.filename}
        side={mode}
      />
    );
  }

  return (
    <div>
      {lines.length > 0 ? (
        <pre className="pr-diff overflow-x-auto text-xs leading-relaxed">
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

function RawFilePane({
  owner,
  repo,
  number,
  path,
  side,
}: {
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: "base" | "head";
}) {
  const file = usePullFileAtRef(owner, repo, number, path, side, true);
  return (
    <div className="relative min-h-full">
      {file.isLoading ? (
        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading raw file…
        </div>
      ) : file.isError ? (
        <div className="m-3 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load raw file.
          {file.error instanceof Error ? ` ${file.error.message}` : null}
        </div>
      ) : file.data?.status === "missing" ? (
        <p className="p-3 text-sm text-muted-foreground">
          N/A — file does not exist on {side}.
        </p>
      ) : file.data?.status === "binary" ? (
        <p className="p-3 text-sm text-muted-foreground">
          N/A — binary file, cannot display as raw text.
        </p>
      ) : (
        <>
          <div className="sticky top-0 z-10 flex justify-end border-b bg-background/95 px-2 py-1 backdrop-blur">
            <CopyButton
              value={file.data?.content ?? ""}
              label={`Copy raw file: ${visibleCopyPath(path)}`}
            />
          </div>
          <pre className="overflow-x-auto whitespace-pre p-3 text-xs leading-relaxed">
            {file.data?.content ?? ""}
          </pre>
        </>
      )}
    </div>
  );
}

function MarkdownPreviewPane({
  owner,
  repo,
  number,
  path,
  side,
}: {
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: "base" | "head";
}) {
  const file = usePullFileAtRef(owner, repo, number, path, side, true);
  return (
    <div className="p-3">
      {file.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading preview…
        </div>
      ) : file.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load preview.
          {file.error instanceof Error ? ` ${file.error.message}` : null}
        </div>
      ) : file.data?.status === "missing" ? (
        <p className="text-sm text-muted-foreground">
          N/A — file does not exist on {side}.
        </p>
      ) : file.data?.status === "binary" ? (
        <p className="text-sm text-muted-foreground">
          N/A — binary file, cannot render as Markdown.
        </p>
      ) : (
        <Markdown owner={owner} repo={repo} className="markdown-preview">
          {file.data?.content ?? ""}
        </Markdown>
      )}
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
    <section className="flex flex-col gap-3 pb-6">
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
