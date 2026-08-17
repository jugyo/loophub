// Issue detail view (/r/:owner/:repo/issues/:number). v1 parity: title, body,
// labels, state, comments, the linked PR, plus the write operations v1 supports
// — comment posting and close/reopen. Body and comments are stored as plain
// Markdown and rendered as GFM via <Markdown>.

import { Link, useRouterState } from "@tanstack/react-router";
import {
  Loader2,
  MoreHorizontal,
  Paperclip,
  Plus,
  Square,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Issue, IssueComment, LinkedPull } from "@/api/types";
import {
  ArchivedComment,
  CommentActionsMenu,
} from "@/components/comment-archive";
import { CommentAuthorLabel } from "@/components/comment-author-label";
import { IssueRow } from "@/components/dashboard-rows";
import {
  DetailHeaderTitle,
  DetailStickyHeader,
} from "@/components/detail-title";
import { IssueBranchChip } from "@/components/issue-branch-chip";
import { IssueHerdrSection } from "@/components/issue-herdr-section";
import { LabelChip } from "@/components/label-chip";
import { LinkedPullSummaryRow } from "@/components/linked-pull-summary";
import { Markdown } from "@/components/markdown";
import { StartWorkflowControls } from "@/components/start-workflow-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { issueBadges, issueCanStartWork, stateBadge } from "@/lib/badges";
import { usePageTitle } from "@/lib/page-title";
import { relativeTime } from "@/lib/time";
import { useAttachmentUpload } from "@/lib/use-attachment-upload";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import {
  useAcceptanceCriteria,
  useAddAcceptanceCriterion,
  useIssue,
  useIssueComments,
  useIssueDetailPage,
  usePostComment,
  useSetAcceptanceCriterionEnabled,
  useSetIssueCommentArchived,
  useSetIssueState,
  useSubIssues,
} from "@/queries/issues";
import { usePullUsage, useUnarchivePull } from "@/queries/pulls";

export function IssueDetail({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const pageQuery = useIssueDetailPage(owner, repo, number);
  const issueQuery = useIssue(owner, repo, number, false);
  const commentsQuery = useIssueComments(owner, repo, number, false);
  const titleRef = useRef<HTMLDivElement>(null);
  const commentsSectionRef = useRef<HTMLElement>(null);
  // An IssueRow's comment count links here with the `#comments` hash, but this section only
  // exists once the page's data has loaded — by then the router has already looked for the anchor
  // and found nothing. Scroll to it when it first exists (parity with PullCommentList / #2394).
  const hash = useRouterState({ select: (state) => state.location.hash });
  useEffect(() => {
    if (hash === "comments") commentsSectionRef.current?.scrollIntoView();
  }, [hash, pageQuery.isLoading, issueQuery.data]);

  if (pageQuery.isLoading) {
    return (
      <div className="mx-auto flex max-w-content items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (pageQuery.isError || !issueQuery.data) {
    return (
      <div className="mx-auto max-w-content rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load issue #{number}.
        {pageQuery.error instanceof Error
          ? ` ${pageQuery.error.message}`
          : null}
      </div>
    );
  }

  const issue = issueQuery.data;

  return (
    // The sticky header (#2033) sits outside the gap-6 column so its sticky box spans the
    // whole page — inside the column it would unstick with the header block it belongs to.
    <div data-debug-component="IssueDetail" className="mx-auto max-w-content">
      <DetailStickyHeader
        kind="Issue"
        number={issue.number}
        title={issue.title}
        badges={issueBadges(issue)}
        titleRef={titleRef}
      />

      <div className="flex flex-col gap-6">
        <IssueHeader
          owner={owner}
          repo={repo}
          issue={issue}
          titleRef={titleRef}
        />

        <LinkedPullSummary owner={owner} repo={repo} issue={issue} />

        <SubIssueSection owner={owner} repo={repo} issue={issue} />

        <IssueHerdrSection owner={owner} repo={repo} issue={issue} />

        <section
          ref={commentsSectionRef}
          id="comments"
          data-debug-component="IssueDiscussion"
          className="flex flex-col gap-6 pb-6"
        >
          <CommentList
            owner={owner}
            repo={repo}
            number={number}
            comments={commentsQuery.data}
            isLoading={false}
            isError={false}
          />

          <CommentForm owner={owner} repo={repo} number={number} />
        </section>
      </div>
    </div>
  );
}

function IssueHeader({
  owner,
  repo,
  issue,
  titleRef,
}: {
  owner: string;
  repo: string;
  issue: Issue;
  titleRef: RefObject<HTMLDivElement | null>;
}) {
  const setState = useSetIssueState(owner, repo, issue.number);
  const state = stateBadge(issue, "issues");
  usePageTitle([`Issue #${issue.number}`, issue.title, `${owner}/${repo}`]);

  return (
    <div data-debug-component="IssueHeader" className="flex flex-col gap-3">
      <DetailHeaderTitle
        kind="Issue"
        number={issue.number}
        title={issue.title}
        titleRef={titleRef}
      />

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
        {issue.ancestors?.map((ancestor, index) => (
          <span key={ancestor.number} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden="true">›</span> : null}
            <Link
              to="/r/$owner/$repo/issues/$number"
              params={{ owner, repo, number: String(ancestor.number) }}
              className="hover:underline"
            >
              #{ancestor.number}
            </Link>
          </span>
        ))}
        <span>
          @{issue.user.login} · opened {relativeTime(issue.created_at)}
        </span>
      </div>

      {issue.labels.length > 0 || issue.target_branch ? (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((l) => (
            <LabelChip key={l.name} name={l.name} owner={owner} repo={repo} />
          ))}
          <IssueBranchChip branch={issue.target_branch} />
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border bg-muted/30">
        {issue.body ? (
          <Markdown owner={owner} repo={repo} className="p-4">
            {issue.body}
          </Markdown>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No description.</p>
        )}
        <AcceptanceCriteria
          key={`${owner}/${repo}#${issue.number}`}
          owner={owner}
          repo={repo}
          issue={issue}
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          disabled={setState.isPending}
          onClick={() =>
            setState.mutate(issue.state === "open" ? "closed" : "open")
          }
        >
          {setState.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          {issue.state === "open" ? "Close" : "Reopen"}
        </Button>
        {/* No implementation-start action on a closed issue, or on one that already
            has an active/merged linked PR — only Reopen (above) remains until the
            issue is reopened (#1256). */}
        {issue.state === "open" && issueCanStartWork(issue) ? (
          <StartWorkflowControls owner={owner} repo={repo} issue={issue} />
        ) : null}
      </div>
    </div>
  );
}

function SubIssueSection({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const query = useSubIssues(owner, repo, issue.number);
  const subIssues = query.data?.issues ?? [];
  if (query.isError) {
    return (
      <section
        data-debug-component="SubIssueSection"
        className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
      >
        Failed to load sub issues.
      </section>
    );
  }
  if (subIssues.length === 0) return null;
  return (
    <section
      data-debug-component="SubIssueSection"
      className="flex flex-col gap-2"
    >
      <h2 className="text-sm font-medium text-muted-foreground">Sub issues</h2>
      <div className="divide-y rounded-md border">
        {subIssues.map((subIssue) => (
          <IssueRow
            key={subIssue.number}
            owner={owner}
            repo={repo}
            issue={subIssue}
            workflowRunSeeded
          />
        ))}
      </div>
      {query.data?.truncated ? (
        <p className="px-2 text-xs text-muted-foreground">
          Showing first 50 sub issues
        </p>
      ) : null}
    </section>
  );
}

// The ordinary issue response remains the enabled-only Verify rubric. The authoring query adds
// disabled criteria for this management surface, preserving stable ids and issue-local numbers.
function AcceptanceCriteria({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const criteriaQuery = useAcceptanceCriteria(owner, repo, issue.number, false);
  const add = useAddAcceptanceCriterion(owner, repo, issue.number);
  const setEnabled = useSetAcceptanceCriterionEnabled(
    owner,
    repo,
    issue.number,
  );
  const [draft, setDraft] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const criteria = criteriaQuery.data ?? [];
  const managementReady = criteriaQuery.data !== undefined;
  const enabled = criteria.filter((criterion) => criterion.enabled);
  const disabled = criteria.filter((criterion) => !criterion.enabled);
  const error = add.error ?? setEnabled.error;

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !managementReady) return;
    setEnabled.reset();
    try {
      await add.mutateAsync(text);
      setDraft("");
    } catch {
      // The mutation error is rendered below through the existing RPC error path.
    }
  }

  return (
    <div
      data-debug-component="IssueAcceptanceCriteria"
      className="flex flex-col gap-3 border-t p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-muted-foreground">
            Acceptance criteria
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Disabled criteria are kept for review history and can be restored.
          </p>
        </div>
        {managementReady && disabled.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showDisabled}
            onClick={() => setShowDisabled((shown) => !shown)}
          >
            {showDisabled ? "Hide" : "Show"} disabled ({disabled.length})
          </Button>
        ) : null}
      </div>

      {criteriaQuery.data === undefined ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading acceptance
          criteria…
        </p>
      ) : enabled.length > 0 ? (
        <ul className="flex flex-col gap-2 text-sm">
          {enabled.map((criterion) => (
            <li key={criterion.id} className="flex items-start gap-2">
              <Square
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 break-words">
                {criterion.text}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                AC {criterion.number}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="-my-1 size-7 shrink-0"
                    aria-label={`Actions for AC ${criterion.number}`}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={setEnabled.isPending}
                    onSelect={() => {
                      add.reset();
                      setEnabled.reset();
                      setEnabled.mutate({ id: criterion.id, enabled: false });
                    }}
                  >
                    Disable criterion
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No active acceptance criteria.
        </p>
      )}

      {managementReady && showDisabled ? (
        <div className="rounded-md border border-dashed p-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            Disabled criteria
          </h3>
          <ul className="flex flex-col gap-2 text-sm">
            {disabled.map((criterion) => (
              <li
                key={criterion.id}
                className="flex items-start gap-2 text-muted-foreground"
              >
                <span className="min-w-0 flex-1 break-words line-through">
                  {criterion.text}
                </span>
                <span className="shrink-0 font-mono text-xs">
                  AC {criterion.number}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="-my-1 size-7 shrink-0"
                      aria-label={`Actions for AC ${criterion.number}`}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={setEnabled.isPending}
                      onSelect={() => {
                        add.reset();
                        setEnabled.reset();
                        setEnabled.mutate({ id: criterion.id, enabled: true });
                      }}
                    >
                      Restore criterion
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* relative: Tailwind sr-only is position:absolute; keep that label's
          containing block on this form so a below-the-fold static position
          cannot expand document scrollHeight (double vertical scrollbar).
          The app shell is also relative; this is defense in depth at the
          control that owns the label. */}
      <form className="relative flex items-center gap-2" onSubmit={onAdd}>
        <label htmlFor="new-acceptance-criterion" className="sr-only">
          New acceptance criterion
        </label>
        <input
          id="new-acceptance-criterion"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add an acceptance criterion"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!managementReady || !draft.trim() || add.isPending}
        >
          {add.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Add
        </Button>
      </form>

      {error ? (
        <p className="text-sm text-destructive">
          {error instanceof Error
            ? error.message
            : "Failed to update acceptance criteria."}
        </p>
      ) : null}
    </div>
  );
}

// Standalone "Linked pull request(s)" section summarizing the issue's linked
// PR(s) at a glance (#269). Rendered as its own section under the issue header
// (not inside it) so it reads as a related entity — not part of the issue body,
// and not a target of the issue's Close/Build actions. A labelled heading makes
// that boundary explicit. Each row matches the Issue list LinkedPullSummaryRow
// (PR number link, workflow progress, metadata; no inline title). Renders
// nothing when no PR is linked. Multiple linked PRs stack vertically. The issue
// page keeps this intentionally limited to identity, state, and navigation;
// review and lifecycle actions belong on the PR detail page.
function LinkedPullSummary({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const [archivesOpen, setArchivesOpen] = useState(false);
  const pulls =
    issue.linked_pull_requests ??
    (issue.linked_pull_request ? [issue.linked_pull_request] : []);
  const archivedPulls = issue.archived_pull_requests ?? [];
  if (pulls.length === 0 && archivedPulls.length === 0) return null;
  return (
    <section
      data-debug-component="LinkedPullSummary"
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {pulls.length > 1 ? "Linked pull requests" : "Linked pull request"}
        </h2>
        {archivedPulls.length > 0 ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => setArchivesOpen(true)}
          >
            Archived pull requests ({archivedPulls.length})
          </button>
        ) : null}
      </div>
      {pulls.map((pull) => (
        <LinkedPullSummaryRowWithUsage
          key={pull.number}
          owner={owner}
          repo={repo}
          pull={pull}
        />
      ))}
      {issue.linked_pull_requests_truncated ? (
        <p className="px-2 text-xs text-muted-foreground">
          Showing the {pulls.length} most relevant pull requests to keep this
          page responsive.
        </p>
      ) : null}
      {archivesOpen ? (
        <ArchivedPullsDialog
          owner={owner}
          repo={repo}
          pulls={archivedPulls}
          truncated={issue.archived_pull_requests_truncated ?? false}
          onClose={() => setArchivesOpen(false)}
        />
      ) : null}
    </section>
  );
}

function ArchivedPullsDialog({
  owner,
  repo,
  pulls,
  truncated,
  onClose,
}: {
  owner: string;
  repo: string;
  pulls: NonNullable<Issue["archived_pull_requests"]>;
  truncated: boolean;
  onClose: () => void;
}) {
  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      {...backdropDismiss}
    >
      <div
        data-debug-component="ArchivedPullsDialog"
        role="dialog"
        aria-modal="true"
        aria-label="Archived pull requests"
        className="flex w-full max-w-lg flex-col rounded-lg border bg-background p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">Archived pull requests</h2>
          <button
            type="button"
            aria-label="Close archived pull requests"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {pulls.map((pull) => (
            <ArchivedPullRow
              key={pull.number}
              owner={owner}
              repo={repo}
              pull={pull}
              onUnarchived={pulls.length === 1 ? onClose : undefined}
            />
          ))}
        </div>
        {truncated ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Showing the {pulls.length} most recently archived pull requests.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// The dialog exists to find an archived attempt and open it, so the row carries
// only its identity — number and title. The operational summary a live linked PR
// row shows (workflow progress, runtime, usage) is noise here and did not fit the
// dialog width.
function ArchivedPullRow({
  owner,
  repo,
  pull,
  onUnarchived,
}: {
  owner: string;
  repo: string;
  pull: NonNullable<Issue["archived_pull_requests"]>[number];
  onUnarchived?: () => void;
}) {
  const unarchive = useUnarchivePull(owner, repo, pull.number);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <Link
          to="/r/$owner/$repo/pulls/$number"
          params={{ owner, repo, number: String(pull.number) }}
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          PR #{pull.number}
        </Link>
        <Link
          to="/r/$owner/$repo/pulls/$number"
          params={{ owner, repo, number: String(pull.number) }}
          className="min-w-0 flex-1 truncate text-sm hover:underline"
          title={pull.title}
        >
          {pull.title}
        </Link>
        <Button
          variant="secondary"
          size="sm"
          disabled={unarchive.isPending}
          onClick={() =>
            unarchive.mutate(undefined, { onSuccess: onUnarchived })
          }
        >
          {unarchive.isPending ? "Unarchiving…" : "Unarchive"}
        </Button>
      </div>
      {unarchive.error ? (
        <p className="text-xs text-destructive">
          {unarchive.error instanceof Error
            ? unarchive.error.message
            : "Unarchive failed"}
        </p>
      ) : null}
    </div>
  );
}

// The row's tokens/cost come from the PR's own usage query (#2263) rather than this page's issue
// payload: a running agent updates them every few seconds, and rebuilding the issue's git-backed
// payload that often costs far more than the two numbers are worth. The values serialized with the
// issue stay on screen until the first usage response lands.
function LinkedPullSummaryRowWithUsage({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
}) {
  const { data: usage } = usePullUsage(owner, repo, pull.number);
  return (
    <LinkedPullSummaryRow
      owner={owner}
      repo={repo}
      pull={usage ? { ...pull, ...usage } : pull}
      // Match Issue list (IssueRow): dim merged/closed, popover on PR link only.
      dimInactive
      popoverTrigger="pull-link"
    />
  );
}

function CommentList({
  owner,
  repo,
  number,
  comments,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  number: number;
  comments: IssueComment[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading comments…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load comments.
      </div>
    );
  }
  if (!comments || comments.length === 0) {
    return <p className="text-sm text-muted-foreground">No comments yet.</p>;
  }
  return (
    <div
      data-debug-component="IssueCommentList"
      className="flex flex-col gap-3"
    >
      {comments.map((c) => (
        <IssueCommentCard
          key={c.id}
          owner={owner}
          repo={repo}
          number={number}
          comment={c}
        />
      ))}
    </div>
  );
}

// One comment in the issue timeline. Archived (#2494) it keeps its place in the timeline but
// collapses to its own header row — author and time — and expands on click; the same three dots
// menu archives and unarchives it.
function IssueCommentCard({
  owner,
  repo,
  number,
  comment,
}: {
  owner: string;
  repo: string;
  number: number;
  comment: IssueComment;
}) {
  const archive = useSetIssueCommentArchived(owner, repo, number);
  const archived = comment.archived_at != null;
  const header = (
    <>
      <CommentAuthorLabel
        author={comment.user.login}
        authorType={comment.author_type}
      />{" "}
      <span className="text-xs font-normal text-muted-foreground">
        {relativeTime(comment.created_at)}
      </span>
    </>
  );
  const menu = (
    <CommentActionsMenu
      label={`Actions for issue comment ${comment.id}`}
      copyMarkdown={comment.body}
      archived={archived}
      busy={archive.isPending}
      onArchived={(next) =>
        archive.mutate({ commentId: comment.id, archived: next })
      }
    />
  );
  const body = (
    <Markdown owner={owner} repo={repo}>
      {comment.body}
    </Markdown>
  );
  return (
    <article
      data-debug-component="IssueComment"
      className={
        archived
          ? "rounded-md border border-dashed px-3 py-2"
          : "rounded-md border p-3"
      }
    >
      {archived ? (
        <ArchivedComment
          label={`Archived issue comment ${comment.id}`}
          preview={header}
          menu={menu}
        >
          {body}
        </ArchivedComment>
      ) : (
        <>
          <header className="mb-1 flex items-start justify-between gap-2 text-sm font-medium">
            <span className="min-w-0">{header}</span>
            {menu}
          </header>
          {body}
        </>
      )}
      {archive.isError ? (
        <p className="mt-2 text-sm text-destructive">
          {archive.error instanceof Error
            ? archive.error.message
            : "Failed to update the comment."}
        </p>
      ) : null}
    </article>
  );
}

function CommentForm({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const [body, setBody] = useState("");
  const post = usePostComment(owner, repo, number);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attach = useAttachmentUpload({
    value: body,
    onChange: setBody,
    textareaRef,
  });

  function submit() {
    const trimmed = body.trim();
    if (!trimmed || post.isPending) return;
    post.mutate(trimmed, { onSuccess: () => setBody("") });
  }

  return (
    <div
      data-debug-component="IssueCommentForm"
      className="flex flex-col gap-2"
    >
      <textarea
        ref={textareaRef}
        aria-label="Add a comment"
        placeholder="Add a comment (paste, drop, or attach a file)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            submit();
          }
        }}
        onPaste={attach.onPaste}
        onDrop={attach.onDrop}
        onDragOver={attach.onDragOver}
        rows={4}
        className="min-h-24 rounded-md border bg-background p-3 text-sm"
      />
      {attach.uploading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Uploading…
        </p>
      ) : null}
      {post.isError ? (
        <p className="text-sm text-destructive">
          {post.error instanceof Error ? post.error.message : "Failed to post."}
        </p>
      ) : null}
      <div className="flex items-center justify-between">
        {/* The picker takes any file; the server rejects unsupported types and the
            error lands in the body as a visible note. */}
        <input
          ref={fileRef}
          type="file"
          multiple
          aria-label="Attach a file"
          className="hidden"
          onChange={(e) => {
            attach.upload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <Button variant="ghost" onClick={() => fileRef.current?.click()}>
          <Paperclip className="size-4" />
          Attach a file
        </Button>
        <Button disabled={!body.trim() || post.isPending} onClick={submit}>
          {post.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Comment
        </Button>
      </div>
    </div>
  );
}
