// Issue detail view (/r/:owner/:repo/issues/:number). v1 parity: title, body,
// labels, state, comments, the linked PR, plus the write operations v1 supports
// — comment posting and close/reopen. Body and comments are stored as plain
// Markdown and rendered as GFM via <Markdown>.

import { Link } from "@tanstack/react-router";
import { Loader2, Play } from "lucide-react";
import { useRef, useState } from "react";
import type {
  Issue,
  IssueComment,
  IssueGroupWithMembers,
  LinkedPull,
} from "@/api/types";
import { IssueRow } from "@/components/dashboard-rows";
import { DetailHeaderTitle } from "@/components/detail-title";
import { IssueDevInfo } from "@/components/dev-info";
import { LabelChip } from "@/components/label-chip";
import { Markdown } from "@/components/markdown";
import { RelatedSessions } from "@/components/related-sessions";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  linkedPullStateBadge,
  linkedPullStatus,
  stateBadge,
} from "@/lib/badges";
import { relativeTime } from "@/lib/time";
import { useImageUpload } from "@/lib/use-image-upload";
import { cn } from "@/lib/utils";
import {
  useIssue,
  useIssueComments,
  useIssueGroups,
  usePostComment,
  useSetIssueState,
} from "@/queries/issues";

export function IssueDetail({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const issueQuery = useIssue(owner, repo, number);
  const commentsQuery = useIssueComments(owner, repo, number);

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
    <div className="mx-auto flex max-w-content flex-col gap-6">
      <IssueHeader owner={owner} repo={repo} issue={issue} />

      <LinkedPullSummary owner={owner} repo={repo} issue={issue} />

      <GroupedIssues owner={owner} repo={repo} number={number} />

      <RelatedSessions
        owner={owner}
        repo={repo}
        sessions={issue.related_sessions}
      />

      <CommentList
        owner={owner}
        repo={repo}
        comments={commentsQuery.data}
        isLoading={commentsQuery.isLoading}
        isError={commentsQuery.isError}
      />

      <CommentForm owner={owner} repo={repo} number={number} />
    </div>
  );
}

// "Other issues in the same group" (#314): for each group this issue belongs to, list its other
// members so a reader can see what comes next when working through the group in order. Reuses the
// shared IssueRow (no bespoke row). The current issue is dropped from each list; a group that holds
// only this issue is skipped. Hides entirely when the issue belongs to no group (or all groups are
// solo), so ungrouped issues stay uncluttered.
function GroupedIssues({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const query = useIssueGroups(owner, repo, number);
  const groups = (query.data ?? [])
    .map(
      (g): IssueGroupWithMembers => ({
        ...g,
        members: g.members.filter((m) => m.number !== number),
      }),
    )
    .filter((g) => g.members.length > 0);

  if (groups.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      {groups.map(({ group, members }) => (
        <div key={group.id} className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">
            Group: {group.name}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              ({members.length} other{members.length === 1 ? "" : "s"})
            </span>
          </h2>
          <ul className="flex flex-col divide-y rounded-md border">
            {members.map((m) => (
              <li key={m.number}>
                <IssueRow owner={owner} repo={repo} issue={m} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
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
  const { launchTerminal } = useTerminalLauncher();
  const state = stateBadge(issue, "issues");
  const linked = issue.linked_pull_request;
  // Build kicks off work, so show it unless a PR is actively in progress (open)
  // or already merged (done). A closed-unmerged (rejected) linked PR should NOT
  // hide Build — the issue still needs a fresh attempt.
  const activePull =
    linked != null && (linked.state === "open" || linked.merged);

  return (
    <div className="flex flex-col gap-3">
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

      {issue.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((l) => (
            <LabelChip key={l.name} name={l.name} owner={owner} repo={repo} />
          ))}
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
        <IssueDevInfo owner={owner} repo={repo} number={issue.number} />
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
        {activePull ? null : (
          <Button
            title={`Start \`lh dev ${issue.number}\` in a terminal`}
            onClick={() =>
              launchTerminal({
                command: `lh dev ${issue.number}`,
                repo: `${owner}/${repo}`,
                label: `dev #${issue.number}`,
                issueRef: { owner, repo, number: issue.number },
                workflow: "issue-dev",
                issueNumber: issue.number,
              })
            }
          >
            <Play className="size-4" />
            Build
          </Button>
        )}
      </div>
    </div>
  );
}

// Standalone "Linked pull request(s)" section summarizing the issue's linked
// PR(s) at a glance (#269). Rendered as its own section under the issue header
// (not inside it) so it reads as a related entity — not part of the issue body,
// and not a target of the issue's Close/Build actions. A labelled heading makes
// that boundary explicit. Each row is a toned `PR #n` link pill + a status word
// + the PR title (also a link). Renders nothing when no PR is linked. Multiple
// linked PRs stack vertically — the issue-detail response sends a single
// `linked_pull_request`, but the plural `linked_pull_requests` is honored when
// present so the display never breaks.
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
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        {pulls.length > 1 ? "Linked pull requests" : "Linked pull request"}
      </h2>
      {pulls.map((pull) => (
        <LinkedPullRow
          key={pull.number}
          owner={owner}
          repo={repo}
          pull={pull}
        />
      ))}
    </section>
  );
}

function LinkedPullRow({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
}) {
  // Prefer the richer git-derived status (working/review/mergeable) when the
  // response carries those fields; the issue-detail summary lacks them, so fall
  // back to the always-available state badge (open/merged/closed).
  const status = linkedPullStatus(pull) ?? linkedPullStateBadge(pull);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <Link
        to="/r/$owner/$repo/pulls/$number"
        params={{ owner, repo, number: String(pull.number) }}
        className={cn(
          badgeVariants({ tone: status.tone }),
          "shrink-0 hover:opacity-80",
        )}
      >
        PR #{pull.number}
      </Link>
      <span
        className="shrink-0 font-medium text-muted-foreground"
        title={status.title}
      >
        {status.label}
      </span>
      <Link
        to="/r/$owner/$repo/pulls/$number"
        params={{ owner, repo, number: String(pull.number) }}
        className="min-w-0 flex-1 truncate text-foreground hover:underline"
        title={pull.title}
      >
        {pull.title}
      </Link>
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
    <div className="flex flex-col gap-3">
      {comments.map((c) => (
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
    <div className="flex flex-col gap-2">
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
