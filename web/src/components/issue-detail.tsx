// Issue detail view (/r/:owner/:repo/issues/:number). v1 parity: title, body,
// labels, state, comments, the linked PR, plus the write operations v1 supports
// — comment posting and close/reopen. Body and comments are stored as plain
// Markdown and rendered as GFM via <Markdown>.

import { Link } from "@tanstack/react-router";
import { Loader2, Play } from "lucide-react";
import { useRef, useState } from "react";
import type { Issue, IssueComment } from "@/api/types";
import { useRegisterDetailTitle } from "@/components/detail-title";
import { IssueDevInfo } from "@/components/dev-info";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { stateBadge } from "@/lib/badges";
import { relativeTime } from "@/lib/time";
import { useImageUpload } from "@/lib/use-image-upload";
import {
  READY_TO_BUILD_LABEL,
  useAddReadyToBuild,
  useIssue,
  useIssueComments,
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
  const addReady = useAddReadyToBuild(owner, repo, issue.number);
  const readyToBuild = issue.labels.some(
    (l) => l.name === READY_TO_BUILD_LABEL,
  );
  const state = stateBadge(issue, "issues");
  const linked = issue.linked_pull_request;
  const titleRef = useRegisterDetailTitle(issue.title);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
        <span className="text-sm text-muted-foreground">#{issue.number}</span>
      </div>

      <h1 ref={titleRef} className="text-2xl font-semibold">
        {issue.title}
      </h1>

      <div className="text-sm text-muted-foreground">
        @{issue.user.login} · opened {relativeTime(issue.created_at)}
      </div>

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
        {readyToBuild ? null : (
          <Button
            disabled={addReady.isPending}
            title="Mark this issue ready for an AFK agent to start"
            onClick={() => addReady.mutate()}
          >
            {addReady.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Build
          </Button>
        )}
      </div>
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
