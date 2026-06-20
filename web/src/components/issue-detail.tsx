// Issue detail view (/r/:owner/:repo/issues/:number). v1 parity: title, body,
// labels, state, agent status, assignee, comments, the linked PR, plus the
// write operations v1 supports — comment posting and close/reopen. Markdown
// rendering is out of scope (#130); body and comments render as plain text.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { Issue, IssueComment } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentStatusLine } from "@/components/agent-status";
import { assigneeBadge, stateBadge } from "@/lib/badges";
import { relativeTime } from "@/lib/time";
import {
  usePostComment,
  useSetIssueState,
  useIssue,
  useIssueComments,
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

      <CommentList
        comments={commentsQuery.data}
        isLoading={commentsQuery.isLoading}
        isError={commentsQuery.isError}
      />

      <CommentForm owner={owner} repo={repo} number={number} />
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
  const agent = assigneeBadge(issue.assignee);
  const linked = issue.linked_pull_request;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
        {agent ? (
          <Badge tone={agent.tone} title={agent.title}>
            {agent.label}
          </Badge>
        ) : null}
        <span className="text-sm text-muted-foreground">#{issue.number}</span>
      </div>

      <h1 className="text-2xl font-semibold">{issue.title}</h1>

      <div className="text-sm text-muted-foreground">
        @{issue.user.login} · opened {relativeTime(issue.created_at)}
      </div>

      <AgentStatusLine status={issue.agent_status} detail />

      {issue.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((l) => (
            <span
              key={l.name}
              className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {l.name}
            </span>
          ))}
        </div>
      ) : null}

      {linked ? (
        <div className="text-sm text-muted-foreground">
          Linked PR:{" "}
          <Link
            to="/r/$owner/$repo/pulls/$number"
            params={{ owner, repo, number: String(linked.number) }}
            className="font-medium text-foreground hover:underline"
          >
            #{linked.number}
          </Link>{" "}
          ({linked.merged ? "merged" : linked.state}) — {linked.title}
        </div>
      ) : null}

      {issue.body ? (
        <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-sm">
          {issue.body}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}

      <div>
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
      </div>
    </div>
  );
}

function CommentList({
  comments,
  isLoading,
  isError,
}: {
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
          <div className="whitespace-pre-wrap text-sm">{c.body}</div>
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

  function submit() {
    const trimmed = body.trim();
    if (!trimmed || post.isPending) return;
    post.mutate(trimmed, { onSuccess: () => setBody("") });
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label="Add a comment"
        placeholder="Add a comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        className="min-h-24 rounded-md border bg-background p-3 text-sm"
      />
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
