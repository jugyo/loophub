// The Conversation block of the GitHub PR view: the comment composer, then the stored comments,
// reviews and inline threads, newest first. Bodies render without the repo's owner/name, so a `#123`
// written on GitHub stays text instead of linking to this hub's unrelated #123, and only http(s)
// links survive.

import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import type {
  GithubConversation,
  GithubConversationEntry,
  GithubConversationThread,
} from "@/api/types";
import { Markdown } from "@/components/markdown";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BadgeTone } from "@/lib/badges";
import { errorMessage } from "@/lib/error-message";
import { relativeTime } from "@/lib/time";
import { useGithubPullAction } from "@/queries/pulls";

const AFTER_SYNC = "Sent to GitHub. It shows here after the next sync.";

const REVIEW_STATE: Record<
  NonNullable<Extract<GithubConversationEntry, { kind: "review" }>["state"]>,
  { tone: BadgeTone; label: string }
> = {
  approved: { tone: "review-passed", label: "Approved" },
  changes_requested: { tone: "review-changes", label: "Changes requested" },
  commented: { tone: "unknown", label: "Commented" },
  dismissed: { tone: "unknown", label: "Dismissed" },
};

interface PaneTarget {
  owner: string;
  repo: string;
  number: number;
}

function Body({ text }: { text: string }) {
  if (text.trim() === "") return null;
  return (
    <Markdown
      breaks
      httpLinksOnly
      className="min-w-0 text-sm break-words [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto"
    >
      {text}
    </Markdown>
  );
}

function Byline({
  author,
  createdAt,
  url,
}: {
  author: string | null;
  createdAt: string;
  url: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 truncate font-medium text-foreground">
        {author ?? "unknown"}
      </span>
      <span className="shrink-0">{relativeTime(createdAt)}</span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on GitHub"
          aria-label="Open on GitHub"
          className="shrink-0"
        >
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

function Composer({
  label,
  submitLabel,
  send,
  onSent,
}: {
  label: string;
  submitLabel: string;
  send: (body: string, callbacks: { onSuccess: () => void }) => void;
  onSent?: () => void;
}) {
  const [body, setBody] = useState("");
  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        send(body, {
          onSuccess: () => {
            setBody("");
            onSent?.();
          },
        });
      }}
    >
      <textarea
        aria-label={label}
        placeholder={label}
        rows={2}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="w-full min-w-0 rounded-md border bg-background p-2 text-sm"
      />
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        className="w-fit"
        disabled={body.trim() === ""}
      >
        {submitLabel}
      </Button>
    </form>
  );
}

function ThreadCard({
  target,
  thread,
  canWrite,
  agentRunning,
  selected,
  onToggle,
}: {
  target: PaneTarget;
  thread: GithubConversationThread;
  canWrite: boolean;
  agentRunning: boolean;
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  const { showError, showInfo } = useToast();
  const action = useGithubPullAction(target.owner, target.repo, target.number);
  const [replying, setReplying] = useState(false);
  // The stored state changes only on the next sweep; this covers the wait.
  const [resolveSent, setResolveSent] = useState(false);
  const resolved = thread.resolved === true || resolveSent;
  const location = thread.line
    ? `${thread.path}:${thread.line}`
    : (thread.path ?? "Unknown file");
  const failed = (fallback: string) => (e: unknown) =>
    showError(errorMessage(e, fallback));
  return (
    <div
      data-debug-component="GithubThread"
      className="flex min-w-0 flex-col gap-2 rounded-md border p-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        {canWrite && thread.resolved === false ? (
          <input
            type="checkbox"
            aria-label={`Select ${location} for the agent`}
            title={
              agentRunning
                ? undefined
                : "No agent is running on this PR, so nothing would act on the request."
            }
            disabled={!agentRunning}
            checked={selected.has(thread.id)}
            onChange={() => onToggle(thread.id)}
          />
        ) : null}
        <span className="min-w-0 flex-1 font-mono text-xs break-all">
          {location}
        </span>
        {thread.resolved !== null || resolveSent ? (
          <Badge tone={resolved ? "review-passed" : "review-rereview"}>
            {resolved ? "Resolved" : "Unresolved"}
          </Badge>
        ) : null}
      </div>
      {thread.comments.map((comment) => (
        <div key={comment.id} className="flex min-w-0 flex-col gap-1">
          <Byline
            author={comment.author}
            createdAt={comment.created_at}
            url={comment.url}
          />
          <Body text={comment.body} />
        </div>
      ))}
      {canWrite ? (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setReplying((open) => !open)}
          >
            Reply
          </Button>
          {!resolved && thread.node_id ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={action.isPending}
              onClick={() =>
                action.mutate(
                  {
                    method: "pulls/resolveGithubThread",
                    params: { thread_id: thread.id },
                  },
                  {
                    onSuccess: () => {
                      setResolveSent(true);
                      showInfo(AFTER_SYNC);
                    },
                    onError: failed("Resolve failed"),
                  },
                )
              }
            >
              <CheckCircle2 className="size-3" />
              Resolve
            </Button>
          ) : null}
        </div>
      ) : null}
      {canWrite && replying ? (
        <Composer
          label="Reply on GitHub"
          submitLabel="Reply"
          onSent={() => setReplying(false)}
          send={(body, { onSuccess }) =>
            action.mutate(
              {
                method: "pulls/replyToGithubThread",
                params: { thread_id: thread.id, body },
              },
              {
                onSuccess: () => {
                  onSuccess();
                  showInfo(AFTER_SYNC);
                },
                onError: failed("Reply failed"),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

export function GithubPrConversation({
  owner,
  repo,
  number,
  query,
  canWrite,
  agentRunning,
  selected,
  onToggle,
}: PaneTarget & {
  query: {
    data: GithubConversation | undefined;
    isLoading: boolean;
    error: unknown;
  };
  canWrite: boolean;
  agentRunning: boolean;
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  const { showError, showInfo } = useToast();
  const action = useGithubPullAction(owner, repo, number);
  const target = { owner, repo, number };
  const threadProps = { target, canWrite, agentRunning, selected, onToggle };
  const entries = query.data?.entries ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {canWrite ? (
        <Composer
          label="Comment on GitHub"
          submitLabel="Comment"
          send={(body, { onSuccess }) =>
            action.mutate(
              { method: "pulls/commentOnGithubPull", params: { body } },
              {
                onSuccess: () => {
                  onSuccess();
                  showInfo(AFTER_SYNC);
                },
                onError: (e) =>
                  showError(errorMessage(e, "Posting the comment failed")),
              },
            )
          }
        />
      ) : null}
      {query.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading conversation…
        </div>
      ) : query.error && !query.data ? (
        <p className="text-sm text-destructive">
          {errorMessage(query.error, "Failed to load the conversation")}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No conversation yet.</p>
      ) : (
        entries.map((entry) => {
          if (entry.kind === "thread") {
            return (
              <ThreadCard
                key={`thread:${entry.thread.id}`}
                thread={entry.thread}
                {...threadProps}
              />
            );
          }
          const verdict =
            entry.kind === "review" && entry.state
              ? REVIEW_STATE[entry.state]
              : null;
          return (
            <div
              key={`${entry.kind}:${entry.id}`}
              data-debug-component="GithubConversationEntry"
              className="flex min-w-0 flex-col gap-1.5"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <Byline
                  author={entry.author}
                  createdAt={entry.created_at}
                  url={entry.url}
                />
                {verdict ? (
                  <Badge tone={verdict.tone}>{verdict.label}</Badge>
                ) : null}
              </div>
              <Body text={entry.body} />
              {entry.kind === "review"
                ? entry.threads.map((thread) => (
                    <ThreadCard
                      key={`thread:${thread.id}`}
                      thread={thread}
                      {...threadProps}
                    />
                  ))
                : null}
            </div>
          );
        })
      )}
    </div>
  );
}
