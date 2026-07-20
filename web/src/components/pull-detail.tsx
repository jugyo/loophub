// PR detail view (/r/:owner/:repo/pulls/:number). v1 parity: title, body,
// state + review badges, head→base, the linked issue (bidirectional with the
// issue's linked PR), the commit/review timeline, the file diff with line comments,
// issue comments, plus the write operations — merge (when PASSED), "mark ready
// for re-review" (when CHANGES_REQUESTED), and close/reopen (when not merged).
// Body, reviews, and comments are stored as plain Markdown and rendered as GFM
// via <Markdown>.

import { Link } from "@tanstack/react-router";
import { ExternalLink, Github, Loader2, UploadCloud } from "lucide-react";
import { useEffect, useState } from "react";
import type { PullFile, PullLineComment, PullRequest } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { DetailHeaderTitle } from "@/components/detail-title";
import { DiffStat } from "@/components/diff-stat";
import { GithubPrStatusSection } from "@/components/github-pr-status";
import { Markdown } from "@/components/markdown";
import { PullCommitsSection } from "@/components/pull-commits-section";
import { PullDebugMenu } from "@/components/pull-debug-menu";
import { DiffFileDialog } from "@/components/pull-diff-dialog";
import { PullHerdrSection } from "@/components/pull-herdr-section";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkDuration } from "@/components/work-duration";
import { WorkflowRunStatusSection } from "@/components/workflow-run-status";
import { pullDetailBadges } from "@/lib/badges";
import { errorMessage } from "@/lib/error-message";
import { usePageTitle } from "@/lib/page-title";
import { relativeTime } from "@/lib/time";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { useIssueComments } from "@/queries/issues";
import {
  useGithubPrStatus,
  useMergePull,
  usePull,
  usePullComments,
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
    // The whole PR detail is a two-column layout (#346): the main column (header, commit/review
    // timeline, diff, comments) on the left and the Sessions sidebar on the right, from the top
    // so ancillary info never interrupts the main vertical flow. Below `lg` the columns stack
    // (flex-col) so the sidebar wraps under the main content on narrow screens. The page widens to
    // `max-w-content-wide` only when the sidebar is present AND beside the content (`lg`); without a
    // sidebar, or while stacked below `lg`, the single column stays at the standard 60rem to line up
    // with the sibling pages (issue-detail, pull-list).
    <div
      data-debug-component="PullDetail"
      className="mx-auto flex max-w-content flex-col gap-6 lg:max-w-content-wide lg:flex-row lg:items-start"
    >
      <div
        data-debug-component="PullMainContent"
        className="flex min-w-0 flex-1 flex-col gap-6"
      >
        {/* No key needed for feedback safety: operation-failure feedback now lives in the app-shell
            error banner (#323), which clears on route change, so a `Merge failed: …` error can no
            longer leak onto the next PR the way the inline mutation-observer error did (#321). */}
        <PullHeader owner={owner} repo={repo} pull={pull} />

        <PullCommitsSection
          owner={owner}
          repo={repo}
          number={number}
          commits={pull.commits}
          reviews={reviewsQuery.data}
          lineComments={lineCommentsQuery.data}
          isReviewsLoading={reviewsQuery.isLoading}
          isReviewsError={reviewsQuery.isError}
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

        <CommentList
          owner={owner}
          repo={repo}
          comments={commentsQuery.data}
          isLoading={commentsQuery.isLoading}
          isError={commentsQuery.isError}
        />
      </div>

      <aside
        data-debug-component="PullSidebar"
        className="flex w-full shrink-0 flex-col gap-6 lg:w-80"
      >
        <PullHerdrSection owner={owner} repo={repo} pull={number} />
        <WorkflowRunSection
          owner={owner}
          repo={repo}
          number={number}
          conflict={pull.mergeable_state === "conflict"}
        />
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

// Workflow run state for this PR (#1008): renders the linked run's status / step / rework via the
// shared section, or nothing when the PR has no run.
function WorkflowRunSection({
  owner,
  repo,
  number,
  conflict,
}: {
  owner: string;
  repo: string;
  number: number;
  /** PR is in merge conflict — surface it on the shared step tracker's Done pill (#1659). */
  conflict: boolean;
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
      conflict={conflict}
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
  // "Ready for review" covers two transitions (#413): a draft PR (opened WIP when work starts)
  // becoming ready, or an already-ready PR resubmitting after change requests. Draft takes precedence.
  const canReady =
    canAct && (pull.draft || pull.review_state === "CHANGES_REQUESTED");
  const mergeBlockedReason = hasConflict
    ? "Cannot merge: this PR has conflicts with the base branch."
    : hasNoCommits
      ? "Cannot merge: this PR has no commits."
      : undefined;

  return (
    <div data-debug-component="PullHeader" className="flex flex-col gap-3">
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
                onError: (e) => showError(errorMessage(e, "Update failed")),
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
                onError: (e) => showError(errorMessage(e, "Update failed")),
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
                  onError: (e) => showError(errorMessage(e, "Merge failed")),
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
                showError(errorMessage(e, "Push to GitHub failed")),
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
    <section
      data-debug-component="FilesChanged"
      className="flex flex-col gap-3"
    >
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
    <li data-debug-component="FileSummaryRow">
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
    <section
      data-debug-component="PullCommentList"
      className="flex flex-col gap-3 pb-6"
    >
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
          <article
            key={c.id}
            data-debug-component="PullComment"
            className="rounded-md border p-3"
          >
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
