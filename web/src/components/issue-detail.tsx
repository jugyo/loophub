// Issue detail view (/r/:owner/:repo/issues/:number). v1 parity: title, body,
// labels, state, comments, the linked PR, plus the write operations v1 supports
// — comment posting and close/reopen. Body and comments are stored as plain
// Markdown and rendered as GFM via <Markdown>.

import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Loader2, Square, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Issue, IssueComment } from "@/api/types";
import { DetailHeaderTitle } from "@/components/detail-title";
import { IssueBranchChip } from "@/components/issue-branch-chip";
import { IssueHerdrSection } from "@/components/issue-herdr-section";
import { LabelChip } from "@/components/label-chip";
import { LinkedPullAttemptSummaryRow } from "@/components/linked-pull-summary";
import { Markdown } from "@/components/markdown";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { issueCanStartWork, stateBadge } from "@/lib/badges";
import {
  hasPlainShortcutModifiers,
  isEditableShortcutTarget,
  isShortcutOverlayActive,
} from "@/lib/keyboard-shortcuts";
import { usePageTitle } from "@/lib/page-title";
import { relativeTime } from "@/lib/time";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { useImageUpload } from "@/lib/use-image-upload";
import {
  useIssue,
  useIssueComments,
  usePostComment,
  useSetIssueState,
} from "@/queries/issues";
import { useWorkflows } from "@/queries/workflows";

export function IssueDetail({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const navigate = useNavigate();
  const issueQuery = useIssue(owner, repo, number);
  const commentsQuery = useIssueComments(owner, repo, number);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.key !== "u" ||
        hasPlainShortcutModifiers(event) ||
        isEditableShortcutTarget(event.target) ||
        isShortcutOverlayActive(event.target)
      ) {
        return;
      }
      event.preventDefault();
      navigate({ to: "/r/$owner/$repo", params: { owner, repo } });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, owner, repo]);

  if (issueQuery.isLoading) {
    return (
      <div className="mx-auto flex max-w-content items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (issueQuery.isError || !issueQuery.data) {
    return (
      <div className="mx-auto max-w-content rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load issue #{number}.
        {issueQuery.error instanceof Error
          ? ` ${issueQuery.error.message}`
          : null}
      </div>
    );
  }

  const issue = issueQuery.data;

  return (
    <div
      data-debug-component="IssueDetail"
      className="mx-auto flex max-w-content flex-col gap-6"
    >
      <IssueHeader owner={owner} repo={repo} issue={issue} />

      <LinkedPullSummary owner={owner} repo={repo} issue={issue} />

      <IssueHerdrSection owner={owner} repo={repo} issue={issue} />

      <section
        data-debug-component="IssueDiscussion"
        className="flex flex-col gap-6 pb-6"
      >
        <CommentList
          owner={owner}
          repo={repo}
          comments={commentsQuery.data}
          isLoading={commentsQuery.isLoading}
          isError={commentsQuery.isError}
        />

        <CommentForm owner={owner} repo={repo} number={number} />
      </section>
    </div>
  );
}

function IssueHeader({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const setState = useSetIssueState(owner, repo, issue.number);
  const state = stateBadge(issue, "issues");
  usePageTitle([`${owner}/${repo}`, `Issue #${issue.number}`, issue.title]);

  return (
    <div data-debug-component="IssueHeader" className="flex flex-col gap-3">
      <DetailHeaderTitle
        kind="Issue"
        number={issue.number}
        title={issue.title}
      />

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
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
        <AcceptanceCriteria issue={issue} />
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

// Start workflow dropdown (#1007): pick a saved workflow by name and launch it
// via `terminal/launch` with workflow "workflow-run", which spawns `lh workflow start
// <owner>/<repo>/<n> --workflow-id <id> --herdr --auto`. Rendered only when the issue has no
// active/merged linked PR (issueCanStartWork), keeping one launch per issue at a time
// (workflow design: CLI / UI). With no saved workflows, the menu links to Settings > Workflows.
function StartWorkflowControls({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const navigate = useNavigate();
  const { data: workflows, isLoading } = useWorkflows();
  const [isLaunching, startLaunching] = useFixedLoading();
  const [menuOpen, setMenuOpen] = useState(false);

  function start(workflowId: number) {
    startLaunching();
    setMenuOpen(false);
    launchTerminal({
      repo: `${owner}/${repo}`,
      label: `Issue #${issue.number} - ${issue.title}`,
      workflow: "workflow-run",
      issueNumber: issue.number,
      workflowId,
    });
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          title="Start a saved workflow in auto mode (no approval prompts, no sandbox)"
          disabled={isLaunching || isLoading}
        >
          {isLaunching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Workflow className="size-4" />
          )}
          Start workflow
          <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {workflows && workflows.length > 0 ? (
          workflows.map((wf) => (
            <DropdownMenuItem
              key={wf.id}
              className="flex-col items-start gap-1 px-3 py-3 whitespace-normal"
              onSelect={(event) => {
                event.preventDefault();
                start(wf.id);
              }}
            >
              <span className="w-full min-w-0 font-medium leading-tight">
                {wf.name}
              </span>
              {wf.description ? (
                <span className="line-clamp-3 w-full min-w-0 break-words text-xs leading-relaxed text-muted-foreground">
                  {wf.description}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              navigate({ to: "/settings/workflows" });
            }}
          >
            No saved workflows — set one up in Settings
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Structured acceptance criteria (#1894) as a read-only checklist (#1897). This is the rubric
// Verify grades the PR against; the grades themselves live on the review and are shown by the
// workflow run section, not here. Kept inside the issue-body box, divided from the body, because
// the criteria are part of what the issue asks for — not a related entity like the linked PR.
// Authoring stays with the CLI (`lh issue ac`), so this offers no add / remove / reorder / enable
// control — the boxes are indicators, not inputs. Renders nothing on an issue with no structured
// criteria (Verify falls back to a holistic review there).
function AcceptanceCriteria({ issue }: { issue: Issue }) {
  const criteria = issue.acceptance_criteria ?? [];
  if (criteria.length === 0) return null;
  return (
    <div
      data-debug-component="IssueAcceptanceCriteria"
      className="flex flex-col gap-2 border-t p-4"
    >
      <h2 className="text-sm font-medium text-muted-foreground">
        Acceptance criteria
      </h2>
      <ul className="flex flex-col gap-2 text-sm">
        {criteria.map((criterion) => (
          <li key={criterion.id} className="flex items-start gap-2">
            <Square
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 break-words">{criterion.text}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Read-only — edit these with <code>lh issue ac</code>.
      </p>
    </div>
  );
}

// Standalone "Linked pull request(s)" section summarizing the issue's linked
// PR(s) at a glance (#269). Rendered as its own section under the issue header
// (not inside it) so it reads as a related entity — not part of the issue body,
// and not a target of the issue's Close/Build actions. A labelled heading makes
// that boundary explicit. Each row is a toned `PR #n` link pill + a status word
// + a visible PR title link. Renders nothing when no PR is linked. Multiple
// linked PRs stack vertically. The issue page keeps this intentionally limited
// to identity, state, and navigation; review and lifecycle actions belong on
// the PR detail page.
function LinkedPullSummary({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const pulls =
    issue.linked_pull_requests ??
    (issue.linked_pull_request ? [issue.linked_pull_request] : []);
  if (pulls.length === 0) return null;
  return (
    <section
      data-debug-component="LinkedPullSummary"
      className="flex flex-col gap-2"
    >
      <h2 className="text-sm font-medium text-muted-foreground">
        {pulls.length > 1 ? "Linked pull requests" : "Linked pull request"}
      </h2>
      {pulls.map((pull) => (
        <LinkedPullAttemptSummaryRow
          key={pull.number}
          owner={owner}
          repo={repo}
          pull={pull}
        />
      ))}
      {issue.linked_pull_requests_truncated ? (
        <p className="px-2 text-xs text-muted-foreground">
          Showing the {pulls.length} most relevant attempts to keep this page
          responsive.
        </p>
      ) : null}
    </section>
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
        <article
          key={c.id}
          data-debug-component="IssueComment"
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
      ))}
    </div>
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
  const image = useImageUpload({ value: body, onChange: setBody, textareaRef });

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
        placeholder="Add a comment (paste or drop an image to attach)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={image.onPaste}
        onDrop={image.onDrop}
        onDragOver={image.onDragOver}
        rows={4}
        className="min-h-24 rounded-md border bg-background p-3 text-sm"
      />
      {image.uploading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Uploading image…
        </p>
      ) : null}
      {post.isError ? (
        <p className="text-sm text-destructive">
          {post.error instanceof Error ? post.error.message : "Failed to post."}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={!body.trim() || post.isPending} onClick={submit}>
          {post.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Comment
        </Button>
      </div>
    </div>
  );
}
