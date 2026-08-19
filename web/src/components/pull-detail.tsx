// PR detail view (/r/:owner/:repo/pulls/:number). v1 parity: title, body,
// state + review badges, head→base, the linked issue (bidirectional with the
// issue's linked PR), the commit/review timeline, the file diff with its diff
// feedback threads for review line comments,
// issue comments, plus the write operations — merge (when PASSED) and close/reopen
// (when not merged).
// Body, reviews, and comments are stored as plain Markdown and rendered as GFM
// via <Markdown>.

import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ExternalLink,
  FlaskConical,
  Github,
  Loader2,
  Map as MapIcon,
  SmilePlus,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  IssueComment,
  PrChangeMap,
  PrTestMap,
  PullFile,
  PullGithubActivity,
  PullLineComment,
  PullRequest,
  PullReview,
  PullTimelineItem,
} from "@/api/types";
import {
  ArchivedComment,
  CommentActionsMenu,
  commentPreview,
} from "@/components/comment-archive";
import { CommentAuthorLabel } from "@/components/comment-author-label";
import { CommentMetadata } from "@/components/comment-metadata";
import { CommitDiffDialog } from "@/components/commit-diff-dialog";
import { CopyButton } from "@/components/copy-button";
import {
  DetailHeaderTitle,
  DetailStickyHeader,
} from "@/components/detail-title";
import { DiffCommentCount } from "@/components/diff-comment-count";
import { DiffStat } from "@/components/diff-stat";
import { FileStatusBadge } from "@/components/file-status-badge";
import { FileViewedBadge } from "@/components/file-viewed-badge";
import { GithubPrStatusSection } from "@/components/github-pr-status";
import { Markdown } from "@/components/markdown";
import { PrChangeMapDialog } from "@/components/pr-change-map-dialog";
import { PrTestMapDialog } from "@/components/pr-test-map-dialog";
import {
  PullCommitsSection,
  ReviewDetailsDialog,
} from "@/components/pull-commits-section";
import { PullDebugMenu } from "@/components/pull-debug-menu";
import {
  DiffFeedbackHistory,
  DiffFileDialog,
} from "@/components/pull-diff-dialog";
import { PullSectionTabs } from "@/components/pull-section-tabs";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { WorkflowRunStatusSection } from "@/components/workflow-run-status";
import { type BadgeTone, pullDetailBadges } from "@/lib/badges";
import { errorMessage } from "@/lib/error-message";
import { usePageTitle } from "@/lib/page-title";
import {
  type PullFileViewState,
  pullFileViewState,
  pullFileViewsByPath,
  viewedPullFileCount,
  visiblePullFiles,
} from "@/lib/pull-file-views";
import { formatDuration, relativeTime } from "@/lib/time";
import { useAutosizeTextarea } from "@/lib/use-autosize-textarea";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { cn } from "@/lib/utils";
import { useWebConfig } from "@/lib/web-config";
import { useIssueComments } from "@/queries/issues";
import {
  useGithubPrStatus,
  useMarkGithubMerged,
  useMergePull,
  usePostPullComment,
  usePull,
  usePullChangeMap,
  usePullComments,
  usePullDetailPage,
  usePullFiles,
  usePullFileViews,
  usePullReviews,
  usePullTestMap,
  usePushGithubPull,
  useReactToPullComment,
  useSetPullCommentArchived,
  useSetPullState,
} from "@/queries/pulls";
import { useRepoGithubPrExportExtraPrompt } from "@/queries/repos";
import { useSettings } from "@/queries/settings";
import { useWorkflowRunForPull } from "@/queries/workflow-runs";
import { githubPrExportPendingUntil } from "../../../core/github-pr-export-pending.ts";
import { prChangeMapPendingUntil } from "../../../core/pr-change-map-pending.ts";
import { prTestMapPendingUntil } from "../../../core/pr-test-map-pending.ts";
import { githubPrExportPrompt } from "../../../core/workflow/github-pr-export-prompt.ts";
import { prChangeMapPrompt } from "../../../core/workflow/pr-change-map-prompt.ts";
import { prTestMapPrompt } from "../../../core/workflow/pr-test-map-prompt.ts";

const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
const COMMENT_REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀"] as const;
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
  const pageQuery = usePullDetailPage(owner, repo, number);
  const pullQuery = usePull(owner, repo, number, false);
  const filesQuery = usePullFiles(owner, repo, number, false);
  const reviewsQuery = usePullReviews(owner, repo, number, false);
  // #354: change map and test map are still experimental, so both sections — viewing and
  // generating alike — are held behind `lh-web --debug`, the same flag the debug panel uses.
  // Their queries stay off without it so a hidden section costs no traffic.
  const { debug } = useWebConfig();
  const changeMapQuery = usePullChangeMap(owner, repo, number, debug);
  const testMapQuery = usePullTestMap(owner, repo, number, debug);
  const lineCommentsQuery = usePullComments(owner, repo, number, false);
  const commentsQuery = useIssueComments(owner, repo, number, false);
  const titleRef = useRef<HTMLDivElement>(null);
  const [measureSidebar, sidebarFitsStickyRoom] =
    useFitsStickyRoom<HTMLElement>(SIDEBAR_STICKY_TOP_PX);
  // #145: which file's diff dialog is open. Owned here — above Files changed — so a timeline line
  // comment (in CommentList) can open the same dialog Files changed renders.
  const [openFilename, setOpenFilename] = useState<string | null>(null);
  // #344: whether the change map dialog is open. Owned here rather than in the sidebar section that
  // opens it, so the dialog can render above the main column and the file diff a map link opens
  // (rendered later, by Files changed) lands on top of it instead of underneath.
  const [changeMapOpen, setChangeMapOpen] = useState(false);
  // #348: whether the test map dialog is open. Owned here for the same reason as the change map —
  // a file diff opened from inside it must land on top of it, not underneath.
  const [testMapOpen, setTestMapOpen] = useState(false);
  const [timelineCommit, setTimelineCommit] = useState<{
    sha: string;
    subject: string;
  } | null>(null);
  const [timelineReview, setTimelineReview] = useState<PullReview | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [scrollButtonCenter, setScrollButtonCenter] = useState<number | null>(
    null,
  );
  useEffect(() => {
    const scrollContainer = document.querySelector<HTMLElement>(
      'main[data-debug-component="RouteContent"]',
    );
    if (!scrollContainer) return;

    let mutationObserver: MutationObserver | null = null;
    let observedTimeline: HTMLElement | null = null;
    const updateScrollToBottom = () => {
      const timeline = document.querySelector<HTMLElement>(
        '[data-debug-component="PullMainContent"]',
      );
      if (timeline) {
        if (mutationObserver && timeline !== observedTimeline) {
          observedTimeline = timeline;
          mutationObserver.observe(timeline, {
            childList: true,
            subtree: true,
          });
        }
        const rect = timeline.getBoundingClientRect();
        setScrollButtonCenter(rect.left + rect.width / 2);
      }
      setShowScrollToBottom(
        scrollContainer.scrollTop + scrollContainer.clientHeight <
          scrollContainer.scrollHeight - 1,
      );
    };

    updateScrollToBottom();
    scrollContainer.addEventListener("scroll", updateScrollToBottom, {
      passive: true,
    });
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(updateScrollToBottom)
        : null;
    resizeObserver?.observe(scrollContainer);
    mutationObserver =
      typeof MutationObserver === "function"
        ? new MutationObserver(updateScrollToBottom)
        : null;
    mutationObserver?.observe(scrollContainer, {
      childList: true,
    });
    updateScrollToBottom();
    return () => {
      scrollContainer.removeEventListener("scroll", updateScrollToBottom);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [pageQuery.isLoading]);
  // Only fetch GitHub status once the PR is known to have a linked GitHub PR — the endpoint 404s
  // otherwise, and the sidebar section is hidden anyway when github_pull is absent (#850).
  const githubStatusQuery = useGithubPrStatus(
    owner,
    repo,
    number,
    !!pullQuery.data?.github_pull,
  );

  if (pageQuery.isLoading) {
    return (
      <div className="mx-auto flex max-w-content items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (pageQuery.isError || !pullQuery.data) {
    return (
      <div className="mx-auto max-w-content rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load PR #{number}.
        {pageQuery.error instanceof Error
          ? ` ${pageQuery.error.message}`
          : null}
      </div>
    );
  }

  const pull = pullQuery.data;
  const timelineReviewGroup = timelineReview
    ? (reviewsQuery.data ?? []).filter(
        (review) => review.head_sha === timelineReview.head_sha,
      )
    : [];
  const timelineReviewCommit = timelineReview
    ? (pull.commits ?? []).find(
        (commit) => commit.sha === timelineReview.head_sha,
      )
    : null;
  const timelineReviewComments = new Map<number, PullLineComment[]>();
  for (const comment of lineCommentsQuery.data ?? []) {
    if (comment.pull_request_review_id == null) continue;
    const comments =
      timelineReviewComments.get(comment.pull_request_review_id) ?? [];
    comments.push(comment);
    timelineReviewComments.set(comment.pull_request_review_id, comments);
  }
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
      className="mx-auto max-w-content lg:max-w-content-wide"
    >
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div data-debug-component="PullMainContent" className="min-w-0 flex-1">
          {/* The sticky header (#2033) sits at the top of the main column, outside its gap-6
              stack (#2089): as a direct child of the column it spans the main content width
              instead of the sidebar too, and its sticky box still covers the whole column so it
              does not unstick with the header block it belongs to. */}
          <DetailStickyHeader
            kind="PR"
            number={pull.number}
            title={pull.title}
            badges={pullDetailBadges(pull)}
            titleRef={titleRef}
          />

          <div className="flex flex-col gap-6">
            {/* No key needed for feedback safety: operation-failure feedback now lives in the
              app-shell error banner (#323), which clears on route change, so a `Merge failed: …`
              error can no longer leak onto the next PR the way the inline mutation-observer error
              did (#321). */}
            <PullHeader
              owner={owner}
              repo={repo}
              pull={pull}
              titleRef={titleRef}
            />
            {/* Section tabs (#59) sit under the PR's title and status and above everything they
                navigate, so they own the top of the scrollport once the page scrolls; each section
                below carries the id they link to. */}
            <PullSectionTabs titleRef={titleRef} />
            <PullBody owner={owner} repo={repo} pull={pull} />

            <PullCommitsSection
              owner={owner}
              repo={repo}
              number={number}
              commits={pull.commits}
              reviews={reviewsQuery.data}
              lineComments={lineCommentsQuery.data}
              isReviewsLoading={false}
              isReviewsError={false}
              showGithubPushState={!!pull.github_pull}
            />
            {timelineCommit ? (
              <CommitDiffDialog
                owner={owner}
                repo={repo}
                sha={timelineCommit.sha}
                subject={timelineCommit.subject}
                onClose={() => setTimelineCommit(null)}
              />
            ) : null}
            {timelineReview ? (
              <ReviewDetailsDialog
                owner={owner}
                repo={repo}
                label={
                  timelineReviewCommit
                    ? `${timelineReviewCommit.sha.slice(0, 7)}: ${timelineReviewCommit.subject}`
                    : (timelineReview.head_sha?.slice(0, 7) ??
                      UNKNOWN_REVIEW_HEAD_LABEL)
                }
                reviews={
                  timelineReviewGroup.length > 0
                    ? timelineReviewGroup
                    : [timelineReview]
                }
                commentsByReview={timelineReviewComments}
                onClose={() => setTimelineReview(null)}
              />
            ) : null}
            {debug && changeMapOpen && changeMapQuery.data ? (
              <PrChangeMapDialog
                changeMap={changeMapQuery.data}
                files={filesQuery.data}
                headSha={pull.head.sha}
                onOpenFile={setOpenFilename}
                onClose={() => setChangeMapOpen(false)}
              />
            ) : null}
            {debug && testMapOpen && testMapQuery.data ? (
              <PrTestMapDialog
                testMap={testMapQuery.data}
                files={filesQuery.data}
                headSha={pull.head.sha}
                onOpenFile={setOpenFilename}
                onClose={() => setTestMapOpen(false)}
              />
            ) : null}
            <FilesChanged
              owner={owner}
              repo={repo}
              number={number}
              files={filesQuery.data}
              commentCounts={pageQuery.data?.diff_feedback.comment_counts ?? {}}
              openFilename={openFilename}
              onOpenFile={setOpenFilename}
              onCloseFile={() => setOpenFilename(null)}
              isLoading={false}
              isError={false}
            />

            {/* #2488: how far the timeline has been unfolded belongs to the PR being read, so a
                different PR remounts the section and starts from its newest page again. */}
            <CommentList
              key={`${owner}/${repo}/${number}`}
              owner={owner}
              repo={repo}
              number={number}
              timeline={pageQuery.data?.timeline}
              comments={commentsQuery.data}
              onOpenCommit={setTimelineCommit}
              onOpenReview={setTimelineReview}
              isLoading={false}
              isError={false}
            />
          </div>
        </div>

        {showScrollToBottom ? (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="fixed bottom-6 left-1/2 z-30 rounded-full border shadow-md"
            style={
              scrollButtonCenter == null
                ? undefined
                : {
                    left: `${scrollButtonCenter}px`,
                    transform: "translateX(-50%)",
                  }
            }
            aria-label="ページ下部へ移動"
            title="ページ下部へ移動"
            onClick={() => {
              const scrollContainer = document.querySelector<HTMLElement>(
                'main[data-debug-component="RouteContent"]',
              );
              scrollContainer?.scrollTo({
                top: scrollContainer.scrollHeight,
                behavior: "smooth",
              });
            }}
          >
            <ArrowDownToLine className="size-4" aria-hidden="true" />
          </Button>
        ) : null}

        {/* The sidebar sticks (#2348) only while it sits beside the main column: below `lg` it
            wraps under the content, where there is nothing left to scroll past it. lg:top-5 parks
            it right under the sticky header (#2033) — the scroll area's own pt-6 shifts sticky
            offsets down by 1.5rem (see DetailStickyHeader's -top-6), so the bar's h-11 bottom edge
            lands at 2.75rem - 1.5rem. A sticky inset applies from the first paint, so the price of
            clearing the bar is that the sidebar starts those same 20px below the main column's
            first line instead of level with it; top-0 would align them but then park the sidebar
            under the bar once the page scrolls. And it sticks only while it still fits that room
            (#2518) — a taller sidebar goes back to the normal flow so its tail scrolls into
            view. */}
        <aside
          ref={measureSidebar}
          data-debug-component="PullSidebar"
          className={cn(
            "flex w-full shrink-0 flex-col gap-6 lg:w-80",
            sidebarFitsStickyRoom && "lg:sticky lg:top-5",
          )}
        >
          {/* #2406: where and on which branch this PR is being worked on is the first thing to
              know when opening it, so the basics lead the sidebar. */}
          <PullInfoSection owner={owner} repo={repo} pull={pull} />
          {debug ? (
            <>
              <PullChangeMapSection
                owner={owner}
                repo={repo}
                pull={pull}
                changeMap={changeMapQuery.data ?? null}
                isLoading={changeMapQuery.isLoading}
                isError={changeMapQuery.isError}
                onOpen={() => setChangeMapOpen(true)}
              />
              <PullTestMapSection
                owner={owner}
                repo={repo}
                pull={pull}
                testMap={testMapQuery.data ?? null}
                isLoading={testMapQuery.isLoading}
                isError={testMapQuery.isError}
                onOpen={() => setTestMapOpen(true)}
              />
            </>
          ) : null}
          <WorkflowRunSection owner={owner} repo={repo} number={number} />
          {/* GitHub PR status (#850) and the actions on the link — push (#2516), unlink (#2384).
            Renders nothing for a PR with no linked GitHub PR; fetched on demand, with loading/error
            inside the section. */}
          <GithubPrStatusSection
            owner={owner}
            repo={repo}
            pull={pull}
            status={githubStatusQuery.data}
            isLoading={githubStatusQuery.isLoading}
          />
        </aside>
      </div>
    </div>
  );
}

/** The sidebar's sticky inset, in px — must match its `lg:top-5`. */
const SIDEBAR_STICKY_TOP_PX = 20;

// #2518: a stuck element never scrolls, so one taller than the room it is stuck in keeps the part
// below the fold off-screen no matter how far the page scrolls. Measures an element against that
// room — the scrollport it would stick inside, minus the inset it sticks at — and reports whether
// sticky is still safe, so the caller can fall back to the normal flow when it is not. The answer
// starts as "fits" because a sticky element that has yet to be measured looks exactly like a static
// one until the page scrolls.
function useFitsStickyRoom<T extends HTMLElement>(topPx: number) {
  // A callback ref, not a ref object: the caller renders its loading state first, so the element
  // arrives on a later render and a mount-time effect would measure nothing and never look again.
  const [element, setElement] = useState<T | null>(null);
  const [fits, setFits] = useState(true);

  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const scrollport = stickyScrollport(element);
      // Sticky insets start inside the scrollport's padding box, so its own top padding eats into
      // the room on top of the inset itself (see the sidebar's pt-6 note).
      const paddingTop =
        Number.parseFloat(getComputedStyle(scrollport).paddingTop) || 0;
      setFits(
        element.offsetHeight <= scrollport.clientHeight - paddingTop - topPx,
      );
    };

    measure();
    // The element's height moves with its own content (sections expanding, async data arriving),
    // the room with the window — watch both so the verdict follows either one.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [element, topPx]);

  return [setElement, fits] as const;
}

// The scrollport a sticky element is pinned inside: its nearest scrollable ancestor, or the page.
function stickyScrollport(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return document.documentElement;
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
        <h2 className="text-lg font-semibold">Workflow</h2>
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
        <h2 className="text-lg font-semibold">Workflow</h2>
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
      showDetail
      observeHerdrSessions
    />
  );
}

// Which PR this is and where it stands: the title and the status badges, nothing else. It sits
// above the section tabs (#59) — the tabs navigate what is being said about the PR, not the
// identity of the PR itself — and is what the Overview tab returns to, so the anchor sits here
// rather than on the description below the bar. Authorship, the head→base pair and the linked
// issue used to repeat here; they now live once, in the sidebar's PR details.
function PullHeader({
  owner,
  repo,
  pull,
  titleRef,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
  titleRef: RefObject<HTMLDivElement | null>;
}) {
  const navigate = useNavigate();
  usePageTitle([`PR #${pull.number}`, pull.title, `${owner}/${repo}`]);

  const badges = pullDetailBadges(pull);

  return (
    <div
      id="overview"
      data-debug-component="PullHeader"
      className="flex scroll-mt-11 flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-2">
        <DetailHeaderTitle
          kind="PR"
          number={pull.number}
          title={pull.title}
          titleRef={titleRef}
        />
        <PullDebugMenu
          owner={owner}
          repo={repo}
          number={pull.number}
          onArchived={() =>
            navigate({ to: "/r/$owner/$repo", params: { owner, repo } })
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {badges.map((b, i) => (
          <Badge key={`${b.tone}-${i}`} tone={b.tone} title={b.title}>
            {b.label}
          </Badge>
        ))}
      </div>
    </div>
  );
}

// The PR's description and the write actions that settle it (close/reopen, merge or the GitHub
// export). It reads as the first thing under the section tabs, the way the commit list and the
// diff read under theirs.
function PullBody({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
}) {
  const merge = useMergePull(owner, repo, pull.number);
  const markGithubMerged = useMarkGithubMerged(owner, repo, pull.number);
  const setState = useSetPullState(owner, repo, pull.number);
  const { showError } = useToast();
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [isMergeLoading, startMergeLoading] = useFixedLoading();
  // The fixed loading window is a UX minimum, not a substitute for the real request: once it
  // elapses the button must stay disabled/spinning until the mutation itself settles, so a
  // slow merge can't be double-submitted (#560).
  const isMerging = isMergeLoading || merge.isPending;

  const canAct = pull.state === "open" && !pull.merged;
  const canMarkGithubMerged =
    canAct &&
    !!pull.github_pull?.github_merged &&
    !!pull.github_pull.github_merged_at;
  // `clean` is the canonical merge-ready state: it already requires a commit, a passing current
  // review, and a conflict-free merge. Agent activity is operational status, not a merge gate.
  const canMerge = canAct && pull.mergeable_state === "clean";
  const mergeBlockedReason =
    pull.mergeable_state === "conflict"
      ? "Cannot merge: this PR has conflicts with the base branch."
      : pull.mergeable_state === "no_commits"
        ? "Cannot merge: this PR has no commits."
        : undefined;

  return (
    // The tabs' Overview covers this block as well as the header above the bar (#59), so it is
    // watched by the scrollspy — but the anchor the tab links to stays the header, which is where
    // Overview means "back to the top".
    <div
      id="pull-body"
      data-debug-component="PullBody"
      className="flex flex-col gap-3"
    >
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
        {canMarkGithubMerged ? (
          <Button
            disabled={markGithubMerged.isPending}
            onClick={() =>
              markGithubMerged.mutate(undefined, {
                onError: (e) =>
                  showError(errorMessage(e, "Mark as merged failed")),
              })
            }
          >
            {markGithubMerged.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Mark as merged
          </Button>
        ) : null}
        {/* #406: the repo's effective merge mode picks exactly one write action — the internal Merge
            control, or the GitHub export (Create PR on GitHub). The two are mutually exclusive, so a
            merged PR shows neither extra control beyond Close/Reopen above.
            The export action is keyed by the PR's full identity: one detail route serves every
            repo, so a client-side navigation reuses it, and without a remount it would carry the
            previous PR's optimistic "creating" state onto a PR that never started one (#2383). The
            repo belongs in the key because PR numbers are per repo — two repos both have a #30. */}
        {pull.merge_mode === "github_pr" ? (
          <GithubPrAction
            key={`${owner}/${repo}#${pull.number}`}
            owner={owner}
            repo={repo}
            pull={pull}
          />
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

// One labeled row of the PR details section: the label above its value, so a long value (a worktree
// path, a branch name) gets the sidebar's full width instead of sharing a line with its label.
function PullInfoRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0">{children}</dd>
    </div>
  );
}

// The PR's basics at the top of the sidebar (#2406, slimmed by #2435): worktree path, the
// head→base branch pair, the linked issue, and who opened it when (#59 — the header above the
// section tabs is down to the title and its status, so this is now the one place these live).
// Every value comes from the PR itself, so the section never loads or fails on its own.
function PullInfoSection({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
}) {
  const linked = pull.linked_issue;
  const isWorkflowAuthor = /^Workflow #\d+\b/.test(pull.user.login);
  return (
    <section
      data-debug-component="PullInfoSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">PR details</h2>
      <dl className="flex flex-col gap-3 rounded-md border p-3 text-sm">
        <PullInfoRow label="Worktree">
          {pull.worktree_path ? (
            <div className="flex items-start gap-1">
              <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 text-xs">
                {pull.worktree_path}
              </code>
              <CopyButton
                value={pull.worktree_path}
                label="Copy worktree path"
                className="size-6"
              />
            </div>
          ) : (
            <span className="text-muted-foreground">Unavailable</span>
          )}
        </PullInfoRow>
        <PullInfoRow label="Branch">
          <div className="flex min-w-0 flex-wrap items-start gap-x-1 gap-y-1">
            <div className="flex min-w-0 max-w-full items-start gap-1">
              <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 text-xs">
                {pull.head.ref}
              </code>
              <CopyButton
                value={pull.head.ref}
                label="Copy head branch"
                className="size-6"
              />
            </div>
            <span className="shrink-0 self-center text-muted-foreground">
              →
            </span>
            {/* The base is copyable too (#1908), symmetrically with the head — the header pair
                that used to carry both copy actions is gone. */}
            <div className="flex min-w-0 max-w-full items-start gap-1">
              <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 text-xs">
                {pull.base.ref}
              </code>
              <CopyButton
                value={pull.base.ref}
                label="Copy base branch"
                className="size-6"
              />
            </div>
          </div>
        </PullInfoRow>
        {linked ? (
          <PullInfoRow label="Linked issue">
            {/* A long issue title must not widen the sidebar, so it truncates on one line and keeps
                its full text in the tooltip. */}
            <div className="flex min-w-0 items-baseline gap-1.5">
              <Link
                to="/r/$owner/$repo/issues/$number"
                params={{ owner, repo, number: String(linked.number) }}
                className="shrink-0 font-medium hover:underline"
              >
                #{linked.number}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">
                ({linked.state})
              </span>
              <span className="min-w-0 flex-1 truncate" title={linked.title}>
                {linked.title}
              </span>
            </div>
          </PullInfoRow>
        ) : null}
        <PullInfoRow label="Opened">
          {/* A Workflow-generated author is the workflow itself, not a person to credit, so it is
              left out the way the header used to leave it out. */}
          <span className="text-muted-foreground">
            {isWorkflowAuthor ? null : (
              <>
                <span className="text-foreground">@{pull.user.login}</span>
                {" · "}
              </>
            )}
            {relativeTime(pull.created_at)}
          </span>
        </PullInfoRow>
      </dl>
    </section>
  );
}

// #344: the PR's change map — the structured map of everything it changed, and the entry point into
// its diffs. Until one exists the section offers Generate change map, which launches an agent with
// the generation instructions (same prompt-injection approach as Create PR on GitHub) and returns
// immediately; the map lands later, when the agent saves it. Once it exists the section opens it.
//
// The launch is fire-and-forget, so the pending state is the click itself, bounded by a TTL
// (core/pr-change-map-pending.ts). A generation that dies leaves its failure in the agent's own
// pane and the button clickable again — regenerating is cheap, since maps are kept per head rather
// than overwritten.
function PullChangeMapSection({
  owner,
  repo,
  pull,
  changeMap,
  isLoading,
  isError,
  onOpen,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
  changeMap: PrChangeMap | null;
  isLoading: boolean;
  isError: boolean;
  onOpen: () => void;
}) {
  const { launchTerminal, launchFailed } = useTerminalLauncher();
  const { data: settings } = useSettings();
  const [clickedAt, setClickedAt] = useState<string | null>(null);
  const isGenerating = usePendingUntil(prChangeMapPendingUntil(clickedAt) ?? 0);
  // The click only stands in for a generation nobody has seen finish. A map that lands is the
  // finish; a rejected launch means no agent started at all, and its failure is already on screen
  // in its own dialog, so neither should leave the button sitting out the TTL.
  useEffect(() => {
    if (launchFailed || changeMap) setClickedAt(null);
  }, [launchFailed, changeMap]);

  const isStale = !!changeMap && changeMap.head_sha !== pull.head.sha;
  return (
    <section
      data-debug-component="PullChangeMapSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">Change map</h2>
      <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
        {isLoading ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </span>
        ) : isError ? (
          // A read that fails is not the same as a PR with no map: a stored document that no longer
          // parses would otherwise render as an unpressed Generate button, quietly inviting a
          // regeneration over a failure nobody was told about.
          <span className="text-xs text-destructive">
            Failed to load the change map.
          </span>
        ) : changeMap ? (
          <>
            <Button variant="secondary" onClick={onOpen}>
              <MapIcon className="size-4" />
              View change map
            </Button>
            <span className="text-xs text-muted-foreground">
              {isStale
                ? `Written against ${changeMap.head_sha.slice(0, 7)}; later commits are not in it`
                : `Generated ${relativeTime(changeMap.created_at)}`}
            </span>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={isGenerating}
              title={
                isGenerating
                  ? "An agent is generating the change map; the action returns if it doesn't land"
                  : "Launch an agent that reads the whole diff and writes a map of everything this PR changed"
              }
              onClick={() => {
                setClickedAt(new Date().toISOString());
                launchTerminal({
                  repo: `${owner}/${repo}`,
                  label: `PR #${pull.number} - ${pull.title}`,
                  workflow: "pr-change-map",
                  prNumber: pull.number,
                  prompt: prChangeMapPrompt({
                    repo: `${owner}/${repo}`,
                    prNumber: pull.number,
                    language: settings?.workflowContractLanguage,
                  }),
                });
              }}
            >
              {isGenerating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MapIcon className="size-4" />
              )}
              {isGenerating ? "Generating…" : "Generate change map"}
            </Button>
            <span className="text-xs text-muted-foreground">
              A structured map of the whole change, linking to every diff.
            </span>
          </>
        )}
      </div>
    </section>
  );
}

// #348: the PR's test map — what the tests it added verify, read without the diff. Same shape as
// the change map section above it: until one exists the section offers Generate test map, which
// launches an agent with the generation instructions and returns immediately; the map lands later,
// when the agent saves it. Once it exists the section opens it.
//
// The launch is fire-and-forget, so the pending state is the click itself, bounded by a TTL
// (core/pr-test-map-pending.ts). A generation that dies leaves its failure in the agent's own pane
// and the button clickable again — regenerating is cheap, since maps are kept per head rather than
// overwritten.
function PullTestMapSection({
  owner,
  repo,
  pull,
  testMap,
  isLoading,
  isError,
  onOpen,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
  testMap: PrTestMap | null;
  isLoading: boolean;
  isError: boolean;
  onOpen: () => void;
}) {
  const { launchTerminal, launchFailed } = useTerminalLauncher();
  const { data: settings } = useSettings();
  const [clickedAt, setClickedAt] = useState<string | null>(null);
  const isGenerating = usePendingUntil(prTestMapPendingUntil(clickedAt) ?? 0);
  // The click only stands in for a generation nobody has seen finish. A map that lands is the
  // finish; a rejected launch means no agent started at all, and its failure is already on screen
  // in its own dialog, so neither should leave the button sitting out the TTL.
  useEffect(() => {
    if (launchFailed || testMap) setClickedAt(null);
  }, [launchFailed, testMap]);

  const isStale = !!testMap && testMap.head_sha !== pull.head.sha;
  return (
    <section
      data-debug-component="PullTestMapSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">Test map</h2>
      <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
        {isLoading ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </span>
        ) : isError ? (
          // A read that fails is not the same as a PR with no map: a stored document that no longer
          // parses would otherwise render as an unpressed Generate button, quietly inviting a
          // regeneration over a failure nobody was told about.
          <span className="text-xs text-destructive">
            Failed to load the test map.
          </span>
        ) : testMap ? (
          <>
            <Button variant="secondary" onClick={onOpen}>
              <FlaskConical className="size-4" />
              View test map
            </Button>
            <span className="text-xs text-muted-foreground">
              {isStale
                ? `Written against ${testMap.head_sha.slice(0, 7)}; later commits are not in it`
                : `Generated ${relativeTime(testMap.created_at)}`}
            </span>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={isGenerating}
              title={
                isGenerating
                  ? "An agent is generating the test map; the action returns if it doesn't land"
                  : "Launch an agent that reads this PR's tests and lists what each one verifies"
              }
              onClick={() => {
                setClickedAt(new Date().toISOString());
                launchTerminal({
                  repo: `${owner}/${repo}`,
                  label: `PR #${pull.number} - ${pull.title}`,
                  workflow: "pr-test-map",
                  prNumber: pull.number,
                  prompt: prTestMapPrompt({
                    repo: `${owner}/${repo}`,
                    prNumber: pull.number,
                    language: settings?.workflowContractLanguage,
                  }),
                });
              }}
            >
              {isGenerating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FlaskConical className="size-4" />
              )}
              {isGenerating ? "Generating…" : "Generate test map"}
            </Button>
            <span className="text-xs text-muted-foreground">
              What the tests in this PR verify, with the code behind each one.
            </span>
          </>
        )}
      </div>
    </section>
  );
}

// Whether `until` (epoch ms, 0 meaning "nothing pending") is still in the future, re-rendering once
// it passes. The answer comes from the clock at render time rather than from a stored "now", so
// every render — including one caused by a timestamp that arrives already expired — is judged
// against the real current time; the timer exists only to force the render that ends the state when
// nothing else would.
function usePendingUntil(until: number): boolean {
  const [, setExpiry] = useState(0);
  useEffect(() => {
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpiry((tick) => tick + 1), remaining);
    return () => clearTimeout(timer);
  }, [until]);
  return until > Date.now();
}

// #406: GitHub-export write action for a PR whose repo is in 'github_pr' mode. Once the PR has been
// exported (github_pull present) the action row is empty here — this is the double-create guard, so
// a second export can't be dispatched. Everything about the resulting link lives in the sidebar's
// GitHub PR section: the route to the GitHub PR (#2091) and pushing to its branch (#2516). Until
// exported, "Create PR on GitHub" injects the full export instructions into a launched agent (#1892,
// same prompt-injection approach as New issue), which generates a branch/title/description in the
// target PR's language and opens the GitHub Draft PR via `lh pr create-github-pr`. That agent runs well
// after the launch RPC returns, so the button holds a loading state for the whole export (#2383).
function GithubPrAction({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
}) {
  const { launchTerminal, launchFailed } = useTerminalLauncher();
  const { data: settings } = useSettings();
  // #2422: optional per-repo extra text appended after the default export prompt.
  const { data: extraPromptSetting } = useRepoGithubPrExportExtraPrompt(
    owner,
    repo,
  );

  // #2383: Create is a fire-and-forget launch — the GitHub PR appears later, when the agent records
  // it — so the button drives its loading state off "an export is running" rather than a mutation's
  // isPending. The server reports the start of an export it hasn't seen finish; `clickedAt` covers
  // the launch RPC itself, before that start has made it back through the events poll, so the button
  // never flickers back to unpressed between the click and the server agreeing. Both are timestamps
  // fed through the same TTL, so whichever is later wins and neither can stick forever.
  const [clickedAt, setClickedAt] = useState<string | null>(null);
  const exportPendingUntil = Math.max(
    githubPrExportPendingUntil(pull.github_pr_export_started_at) ?? 0,
    githubPrExportPendingUntil(clickedAt) ?? 0,
  );
  const isCreating = usePendingUntil(exportPendingUntil);
  // The optimistic timestamp is only a stand-in until the server has its own account of this
  // export, so drop it as soon as one arrives: the server reports the start itself, or a GitHub PR
  // lands. Both are what makes the server's answer authoritative again — otherwise unlinking that
  // GitHub PR (#2384) to export a second time brings back a Create button that claims to be working
  // on a click that is long over. A rejected launch is the third way the click stops standing for
  // anything: no agent started, so the operator can retry immediately instead of sitting out the
  // TTL — the failure is already on screen in its own dialog.
  useEffect(() => {
    if (launchFailed || pull.github_pull || pull.github_pr_export_started_at)
      setClickedAt(null);
  }, [launchFailed, pull.github_pull, pull.github_pr_export_started_at]);

  // Exported already: the GitHub-side controls are the sidebar section's (#2516), so this row has
  // nothing left to offer.
  if (pull.github_pull) return null;
  // A merged or closed loophub PR is past the point of exporting, so offer Create only while open.
  if (pull.state !== "open" || pull.merged) return null;
  return (
    <Button
      disabled={isCreating}
      title={
        isCreating
          ? "An agent is creating the GitHub PR; the action returns if it doesn't land"
          : "Create a PR on GitHub from this branch by launching an agent with the export instructions"
      }
      onClick={() => {
        setClickedAt(new Date().toISOString());
        launchTerminal({
          repo: `${owner}/${repo}`,
          label: `PR #${pull.number} - ${pull.title}`,
          workflow: "github-pr-export",
          prNumber: pull.number,
          prompt: githubPrExportPrompt({
            repo: `${owner}/${repo}`,
            prNumber: pull.number,
            language: settings?.workflowContractLanguage,
            extraPrompt: extraPromptSetting?.extra_prompt ?? null,
          }),
        });
      }}
    >
      {isCreating ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Github className="size-4" />
      )}
      {isCreating ? "Creating…" : "Create PR on GitHub"}
    </Button>
  );
}

function FilesChanged({
  owner,
  repo,
  number,
  files,
  commentCounts,
  openFilename,
  onOpenFile,
  onCloseFile,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  number: number;
  files: PullFile[] | undefined;
  /** Per-file diff feedback counts, from the same page query that produced `files` (#123). */
  commentCounts: Record<string, number>;
  /** Which file's diff dialog is open. */
  openFilename: string | null;
  onOpenFile: (filename: string) => void;
  onCloseFile: () => void;
  isLoading: boolean;
  isError: boolean;
}) {
  const viewsQuery = usePullFileViews(owner, repo, number);
  const viewsByPath = useMemo(
    () => pullFileViewsByPath(viewsQuery.data),
    [viewsQuery.data],
  );
  const [showViewed, setShowViewed] = useState(false);
  const visibleFiles = useMemo(
    () => (files ? visiblePullFiles(files, viewsByPath, showViewed) : []),
    [files, showViewed, viewsByPath],
  );
  const viewedCount = files ? viewedPullFileCount(files, viewsByPath) : 0;
  // Viewed files are meant to be gone by the time the list paints, so hold the section on the
  // record as well as on the diff rather than showing rows that are about to disappear.
  const loading = isLoading || viewsQuery.isPending;

  const openFile =
    files && openFilename ? (findPullFile(files, openFilename) ?? null) : null;
  // A line comment can name a path the current diff no longer has (a file reverted since the
  // comment was made): nothing to show, so the pending open is dropped instead of a dangling dialog.
  useEffect(() => {
    if (openFilename && files && !openFile) onCloseFile();
  }, [files, openFile, openFilename, onCloseFile]);

  const totalAdditions =
    files?.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const totalDeletions =
    files?.reduce((sum, file) => sum + file.deletions, 0) ?? 0;

  return (
    <section
      id="files-changed"
      data-debug-component="FilesChanged"
      className="flex scroll-mt-11 flex-col gap-3"
    >
      <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
        Files changed{files ? ` (${files.length})` : ""}
        {files && files.length > 0 ? (
          <DiffStat
            additions={totalAdditions}
            deletions={totalDeletions}
            className="text-sm font-normal"
          />
        ) : null}
        {/* The count is the viewed total rather than what is hidden right now, so it reads the
            same with the toggle on or off (#2502, #2514). */}
        {files && files.length > 0 ? (
          <Switch
            className="ml-auto"
            label="Show viewed"
            hint={`(${viewedCount} viewed)`}
            checked={showViewed}
            onCheckedChange={setShowViewed}
          />
        ) : null}
      </h2>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading diff…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load diff.
        </div>
      ) : !files || files.length === 0 ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">No diff.</p>
          <DiffFeedbackHistory
            owner={owner}
            repo={repo}
            number={number}
            fetchEnabled={false}
          />
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-md border">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b bg-muted/40 px-2.5 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
              <span>File</span>
              <span>Changes</span>
            </div>
            <ul className="divide-y">
              {visibleFiles.map((file) => (
                <FileSummaryRow
                  key={file.filename}
                  file={file}
                  viewState={pullFileViewState(file, viewsByPath)}
                  commentCount={commentCounts[file.filename] ?? 0}
                  onOpen={() => onOpenFile(file.filename)}
                />
              ))}
              {visibleFiles.length === 0 ? (
                <li className="px-2.5 py-2 text-sm text-muted-foreground">
                  Every changed file is marked viewed.
                </li>
              ) : null}
            </ul>
          </div>
          <DiffFeedbackHistory
            owner={owner}
            repo={repo}
            number={number}
            fetchEnabled={false}
          />
          {openFile ? (
            <DiffFileDialog
              owner={owner}
              repo={repo}
              number={number}
              files={files}
              file={openFile}
              commentCounts={commentCounts}
              onSelectFile={onOpenFile}
              onClose={onCloseFile}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function FileSummaryRow({
  file,
  viewState,
  commentCount,
  onOpen,
}: {
  file: PullFile;
  viewState: PullFileViewState;
  commentCount: number;
  onOpen: () => void;
}) {
  return (
    <li data-debug-component="FileSummaryRow">
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-[auto_minmax(0,max-content)_auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <FileStatusBadge status={file.status} />
        <span className="min-w-0 truncate font-mono text-xs [direction:rtl]">
          {file.filename}
        </span>
        <DiffStat
          additions={file.additions}
          deletions={file.deletions}
          className="justify-self-end text-xs"
        />
        <span aria-hidden="true" />
        {/* The change time, its separator and the comment count are optional, so they share the
            trailing cell: as separate children they would outnumber the row's columns and wrap.
            The cell keeps its own content-sized column — in the flexible one it would collapse to
            zero once a long filename absorbs the row's free space and then overflow the diff stat. */}
        <span className="flex items-center gap-2 whitespace-nowrap">
          <FileViewedBadge state={viewState} />
          {file.last_changed_at ? (
            <span
              className="text-xs text-muted-foreground"
              title={new Date(file.last_changed_at).toLocaleString()}
            >
              {relativeTime(file.last_changed_at)}
            </span>
          ) : null}
          {file.last_changed_at && commentCount > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
          ) : null}
          <DiffCommentCount count={commentCount} className="text-xs" />
        </span>
      </button>
    </li>
  );
}

// The comment list is the PR's timeline (#145): conversation comments, commits and reviews, in the
// chronological order the backend assembled (`timeline`). Comment cards still read
// the live `comments` query — which carries optimistic posts and reactions — so the section keeps
// its instant feedback while the timeline supplies the order and the other kinds.

// A stable key for a timeline entry. Prefixed by kind so entries that happen to share an id cannot
// collide as React siblings.
function timelineItemKey(item: PullTimelineItem): string {
  switch (item.kind) {
    case "commit":
      return `commit:${item.commit.sha}`;
    case "review":
      return `review:${item.review.id}`;
    case "comment":
      return `comment:${item.comment.id}`;
    // GitHub's own id identifies a feedback item; the merge has none, and there is only ever one.
    case "github_activity":
      return `github:${item.github_activity.type}:${item.github_activity.github_id ?? "merged"}`;
    default:
      return "unknown";
  }
}

// The rendered entry for a timeline item, given everything the entry kinds need.
function timelineItemContent(
  item: PullTimelineItem,
  context: {
    owner: string;
    repo: string;
    onOpenCommit: (commit: { sha: string; subject: string }) => void;
    onOpenReview: (review: PullReview) => void;
    reaction: ReturnType<typeof useReactToPullComment>;
    archive: ReturnType<typeof useSetPullCommentArchived>;
    showError: (message: string) => void;
  },
) {
  switch (item.kind) {
    case "commit":
      return (
        <TimelineCommitItem item={item} onOpenCommit={context.onOpenCommit} />
      );
    case "review":
      return (
        <TimelineReviewItem item={item} onOpenReview={context.onOpenReview} />
      );
    case "comment":
      return (
        <CommentCard
          owner={context.owner}
          repo={context.repo}
          comment={item.comment}
          reaction={context.reaction}
          archive={context.archive}
          showError={context.showError}
        />
      );
    case "github_activity":
      return <TimelineGithubActivityItem item={item} />;
    default:
      return null;
  }
}

// #2488: a PR that ran for a while has a timeline that is mostly history. Only the newest page is
// rendered; "Load more" unfolds the older entries a page at a time.
const TIMELINE_PAGE_SIZE = 20;

function CommentList({
  owner,
  repo,
  number,
  timeline,
  comments,
  onOpenCommit,
  onOpenReview,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  number: number;
  timeline: PullTimelineItem[] | undefined;
  comments: IssueComment[] | undefined;
  onOpenCommit: (commit: { sha: string; subject: string }) => void;
  onOpenReview: (review: PullReview) => void;
  isLoading: boolean;
  isError: boolean;
}) {
  const [body, setBody] = useState("");
  const [visibleCount, setVisibleCount] = useState(TIMELINE_PAGE_SIZE);
  const [postFailed, setPostFailed] = useState(false);
  const textareaRef = useAutosizeTextarea(body);
  const sectionRef = useRef<HTMLElement>(null);
  // #2394: a row's comment count links here with the `#comments` hash, but this section only exists
  // once the page's data has loaded — by then the router has already looked for the anchor and found
  // nothing. Scroll to it when it first exists. The in-page "Comments (n)" link needs no help: it is
  // a same-document anchor the browser jumps to itself.
  const hash = useRouterState({ select: (state) => state.location.hash });
  useEffect(() => {
    if (hash === "comments") sectionRef.current?.scrollIntoView();
  }, [hash]);
  const reaction = useReactToPullComment(owner, repo, number);
  const archive = useSetPullCommentArchived(owner, repo, number);
  const { showError } = useToast();
  const post = usePostPullComment(owner, repo, number, (_error, failedBody) => {
    setBody(failedBody);
    setPostFailed(true);
  });

  function submit() {
    const trimmed = body.trim();
    if (!trimmed || post.isPending) return;
    setPostFailed(false);
    setBody("");
    post.mutate(trimmed);
  }

  // Reconcile the backend timeline against the live comments query: comment entries pick up the
  // live row (optimistic post/reaction/archive), and comments the server has not echoed into the
  // timeline yet are appended newest-last. The order and presence of everything else is the
  // backend's — this is comment-card freshness only, not a rebuild of the timeline.
  const items = useMemo(() => {
    if (!timeline) return timeline;
    const live = new Map(
      comments?.map((comment) => [comment.id, comment]) ?? [],
    );
    const knownIds = new Set(
      timeline
        .filter(
          (item): item is Extract<PullTimelineItem, { kind: "comment" }> =>
            item.kind === "comment",
        )
        .map((item) => item.comment.id),
    );
    return [
      ...timeline.map((item) =>
        item.kind === "comment" && live.has(item.comment.id)
          ? { ...item, comment: live.get(item.comment.id)! }
          : item,
      ),
      ...(comments ?? [])
        .filter((comment) => !knownIds.has(comment.id))
        .map((comment) => ({
          kind: "comment" as const,
          created_at: comment.created_at,
          comment,
        })),
    ];
  }, [comments, timeline]);

  // Group the timeline into runs of consecutive non-comment entries so the connector line spans
  // only those; a conversation comment breaks the line and renders as its own full-width card
  // (PR comment #307). Order is untouched — the runs are the original sequence split at comments.
  const runs = useMemo(() => {
    const grouped: PullTimelineItem[][] = [];
    let run: PullTimelineItem[] = [];
    // The newest entries are the ones on screen; everything older waits behind "Load more".
    for (const item of (items ?? []).slice(-visibleCount)) {
      if (item.kind === "comment") {
        if (run.length) grouped.push(run);
        run = [];
        grouped.push([item]);
      } else {
        run.push(item);
      }
    }
    if (run.length) grouped.push(run);
    return grouped;
  }, [items, visibleCount]);

  // Everything the entry renderers need, collected once for the runs below.
  const itemContext = {
    owner,
    repo,
    onOpenCommit,
    onOpenReview,
    reaction,
    archive,
    showError,
  };

  return (
    <section
      ref={sectionRef}
      id="comments"
      data-debug-component="PullCommentList"
      className="flex scroll-mt-11 flex-col gap-3 pb-6"
    >
      <h2 className="text-lg font-semibold">
        Comments ({comments?.length ?? 0})
      </h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading comments…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load comments.
        </div>
      ) : !items || items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments.</p>
      ) : (
        // Activity entries (commits and reviews) are connected by a vertical line with a
        // dot per entry, the way the workflow run history does (WorkflowRunDetailDialog): the line
        // is the run's left border and each dot (with its ring) masks the line behind it. A
        // conversation comment breaks the run and renders as its own full-width card — the line
        // does not pass through comments (PR comment #300, #307).
        <>
          {/* The hidden entries are the older ones, which belong above what is shown, so the
              control that unfolds them sits at the top of the timeline rather than the bottom. */}
          {items.length > visibleCount ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() =>
                  setVisibleCount((count) => count + TIMELINE_PAGE_SIZE)
                }
              >
                Load more
              </Button>
            </div>
          ) : null}
          {runs.map((group) =>
            group[0].kind === "comment" ? (
              <CommentCard
                key={timelineItemKey(group[0])}
                comment={group[0].comment}
                {...itemContext}
              />
            ) : (
              <ol
                key={`run:${timelineItemKey(group[0])}`}
                className="relative ml-2 border-l pl-5"
              >
                {group.map((item) => (
                  <li
                    key={timelineItemKey(item)}
                    className="relative pb-3 last:pb-0"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute -left-[1.55rem] top-1.5 size-2 rounded-full bg-muted-foreground/60 ring-4 ring-background"
                    />
                    {timelineItemContent(item, itemContext)}
                  </li>
                ))}
              </ol>
            ),
          )}
        </>
      )}
      <div
        data-debug-component="PullCommentForm"
        className="flex flex-col gap-2"
      >
        <textarea
          ref={textareaRef}
          aria-label="Add a PR comment"
          placeholder="Add a comment"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={4}
          className="min-h-24 w-full resize-none overflow-hidden rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-end gap-2">
          {postFailed ? (
            <span className="text-sm text-destructive">
              Failed to post comment.
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={!body.trim() || post.isPending}
          >
            {post.isPending ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : null}
            Comment
          </Button>
        </div>
      </div>
    </section>
  );
}

// A conversation comment in the timeline (#145). The card and every action on it are unchanged from
// before the timeline — only the data source moved from "the comments list" to a timeline entry.
function CommentCard({
  owner,
  repo,
  comment,
  reaction,
  archive,
  showError,
}: {
  owner: string;
  repo: string;
  comment: IssueComment;
  reaction: ReturnType<typeof useReactToPullComment>;
  archive: ReturnType<typeof useSetPullCommentArchived>;
  showError: (message: string) => void;
}) {
  const archived = comment.archived_at != null;
  const menu = (
    <CommentActionsMenu
      label={`Actions for PR comment ${comment.id}`}
      copyMarkdown={comment.body}
      archived={archived}
      busy={archive.isPending}
      onArchived={(next) =>
        archive.mutate(
          { commentId: comment.id, archived: next },
          {
            onError: (error) =>
              showError(
                errorMessage(
                  error,
                  next ? "Archive failed" : "Unarchive failed",
                ),
              ),
          },
        )
      }
    />
  );
  const content = (
    <>
      <Markdown owner={owner} repo={repo}>
        {comment.body}
      </Markdown>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {comment.reactions.map((item) => (
          <button
            type="button"
            key={item.emoji}
            aria-label={`${item.emoji} reaction: ${item.count}`}
            aria-pressed={item.reacted}
            disabled={reaction.isPending}
            onClick={() =>
              reaction.mutate(
                { commentId: comment.id, emoji: item.emoji },
                {
                  onError: (error) =>
                    showError(errorMessage(error, "Reaction failed")),
                },
              )
            }
            className={
              item.reacted
                ? "rounded-full border bg-accent px-2 py-0.5 text-xs text-accent-foreground"
                : "rounded-full border bg-background px-2 py-0.5 text-xs"
            }
          >
            {item.emoji} {item.count}
          </button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Add reaction to PR comment ${comment.id}`}
              disabled={reaction.isPending}
            >
              <SmilePlus className="size-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="flex min-w-0 gap-1 p-1">
            {COMMENT_REACTIONS.map((emoji) => (
              <DropdownMenuItem
                key={emoji}
                className="flex size-8 cursor-pointer items-center justify-center p-0 text-base"
                aria-label={`React to PR comment ${comment.id} with ${emoji}`}
                onSelect={() =>
                  reaction.mutate(
                    { commentId: comment.id, emoji },
                    {
                      onError: (error) =>
                        showError(errorMessage(error, "Reaction failed")),
                    },
                  )
                }
              >
                {emoji}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
  return (
    <article
      data-debug-component="PullComment"
      className={
        archived
          ? "rounded-md border border-dashed px-3 py-2"
          : "rounded-md border p-3"
      }
    >
      {archived ? (
        <ArchivedComment
          label={`Archived PR comment ${comment.id}`}
          preview={`${comment.user.login}: ${commentPreview(comment.body)}`}
          menu={menu}
        >
          <header className="mb-1">
            <CommentMetadata
              author={comment.user.login}
              authorType={comment.author_type}
              createdAt={comment.created_at}
              id={comment.id}
            />
          </header>
          {content}
        </ArchivedComment>
      ) : (
        <>
          <header className="mb-1 flex items-start justify-between gap-2">
            <CommentMetadata
              author={comment.user.login}
              authorType={comment.author_type}
              createdAt={comment.created_at}
              id={comment.id}
            />
            {menu}
          </header>
          {content}
        </>
      )}
    </article>
  );
}

// How a review's event reads in the timeline (#145): the same verdict labels the Commits section
// uses, falling back to the raw state for an event we do not special-case.
const REVIEW_VERDICT: Record<string, { tone: BadgeTone; label: string }> = {
  PASS: { tone: "review-passed", label: "passed" },
  REQUEST_CHANGES: { tone: "review-changes", label: "changes requested" },
  COMMENT: { tone: "review-commented", label: "commented" },
};
const UNKNOWN_REVIEW_HEAD_LABEL = "Unknown commit";

// One commit in the timeline (#145): the same facts the Commits section rows carry, without the
// review grouping that section owns. Kept to a plain, low row — non-comment entries recede next
// to the bordered comment cards (PR comment #288).
function TimelineCommitItem({
  item,
  onOpenCommit,
}: {
  item: Extract<PullTimelineItem, { kind: "commit" }>;
  onOpenCommit: (commit: { sha: string; subject: string }) => void;
}) {
  const shortSha = item.commit.sha.slice(0, 7);
  return (
    <article data-debug-component="TimelineCommit" className="px-1 py-0.5">
      <button
        type="button"
        aria-label={`View timeline changes in ${shortSha}: ${item.commit.subject}`}
        onClick={() => onOpenCommit(item.commit)}
        className="flex w-full min-w-0 items-center gap-2 rounded text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <code className="shrink-0 rounded bg-muted px-1 py-px text-[10px] leading-4 text-muted-foreground">
          {shortSha}
        </code>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {item.commit.subject}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground/80">
          {item.commit.author} ·{" "}
          <time dateTime={item.created_at} title={item.created_at}>
            {relativeTime(item.created_at)}
          </time>
        </span>
      </button>
    </article>
  );
}

// One review in the timeline (#145): a single minimal line — verdict, author, model and duration —
// in its chronological place. The full review body stays in the Commits section's review dialog
// (PR comment #313).
function TimelineReviewItem({
  item,
  onOpenReview,
}: {
  item: Extract<PullTimelineItem, { kind: "review" }>;
  onOpenReview: (review: PullReview) => void;
}) {
  const review = item.review;
  const verdict =
    REVIEW_VERDICT[review.state] ??
    ({ tone: "review-commented", label: review.state } as const);
  return (
    <article data-debug-component="TimelineReview" className="px-1 py-0.5">
      <button
        type="button"
        aria-label={`View review for ${review.head_sha?.slice(0, 7) ?? UNKNOWN_REVIEW_HEAD_LABEL}`}
        onClick={() => onOpenReview(review)}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        <CommentAuthorLabel
          author={review.user.login}
          authorType={review.author_type}
        />
        {review.model ? (
          <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">
            {review.model}
          </span>
        ) : null}
        <time
          dateTime={item.created_at}
          title={item.created_at}
          className="text-xs text-muted-foreground"
        >
          {relativeTime(item.created_at)}
        </time>
        {/* How long the review itself took (#2387). Omitted — never 0 — for a review whose
            duration the wire could not derive. */}
        {review.duration_seconds !== null ? (
          <span
            className="text-xs text-muted-foreground"
            title={`Review took ${review.duration_seconds}s`}
          >
            {" · took "}
            {formatDuration(review.duration_seconds)}
          </span>
        ) : null}
      </button>
    </article>
  );
}

// What each GitHub-side happening reads as in the timeline (#2500). Every label ends in "on GitHub"
// so the entry says where it happened even when its icon is missed.
const GITHUB_ACTIVITY_LABEL: Record<PullGithubActivity["type"], string> = {
  issue_comment: "Commented on GitHub",
  review: "Reviewed on GitHub",
  review_comment: "Commented on a diff line on GitHub",
  merged: "Merged on GitHub",
};

// A GitHub review's verdict, in the tones the LoopHub review badges already use so one timeline
// does not speak two colour languages.
const GITHUB_REVIEW_VERDICT: Record<
  NonNullable<PullGithubActivity["review_state"]>,
  { tone: BadgeTone; label: string }
> = {
  approved: { tone: "review-passed", label: "approved" },
  changes_requested: { tone: "review-changes", label: "changes requested" },
  commented: { tone: "review-commented", label: "commented" },
  dismissed: { tone: "unknown", label: "dismissed" },
};

// One GitHub-side happening in the timeline (#2500): the same minimal line the commit and review
// entries use, marked with the GitHub icon and linking out to the item on GitHub — the body itself
// stays on GitHub, the way a LoopHub review's body stays in its dialog. The author is absent for an
// item observed before it was recorded, and for the merge entry, so the line reads without it.
function TimelineGithubActivityItem({
  item,
}: {
  item: Extract<PullTimelineItem, { kind: "github_activity" }>;
}) {
  const activity = item.github_activity;
  const verdict = activity.review_state
    ? GITHUB_REVIEW_VERDICT[activity.review_state]
    : null;
  return (
    <article
      data-debug-component="TimelineGithubActivity"
      className="px-1 py-0.5"
    >
      <a
        href={activity.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`GitHub PR #${activity.github_number}`}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Github className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          {GITHUB_ACTIVITY_LABEL[activity.type]}
        </span>
        {verdict ? <Badge tone={verdict.tone}>{verdict.label}</Badge> : null}
        {activity.author ? (
          <span className="text-muted-foreground">@{activity.author}</span>
        ) : null}
        <time
          dateTime={item.created_at}
          title={item.created_at}
          className="text-muted-foreground"
        >
          {relativeTime(item.created_at)}
        </time>
        <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
      </a>
    </article>
  );
}

// A changed file matching a path as a line comment names it: the display filename or either side
// of a rename. Undefined when the path is not in the current diff (#145).
function findPullFile(files: PullFile[], path: string): PullFile | undefined {
  return files.find(
    (file) =>
      file.filename === path ||
      file.headFilename === path ||
      file.previousFilename === path,
  );
}
