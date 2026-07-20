import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Mail,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { InboxJsonObject, InboxMessage } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useWebConfig } from "@/lib/web-config";
import { useInboxMessageAction, useInboxMessages } from "@/queries/inbox";

function compactJson(value: InboxJsonObject | null): string {
  if (!value) return "-";
  const preferred = ["actor", "kind", "repo", "task_id", "run_id"];
  const parts = preferred
    .filter((key) => value[key] != null)
    .map((key) => `${key}:${String(value[key])}`);
  if (parts.length > 0) return parts.join(" ");
  return JSON.stringify(value);
}

function scheduledTaskSource(value: InboxJsonObject | null): {
  repo: string;
  taskId: number;
  runId: number;
} | null {
  if (
    value?.kind !== "scheduled_task" ||
    typeof value.repo !== "string" ||
    typeof value.task_id !== "number" ||
    typeof value.run_id !== "number"
  ) {
    return null;
  }
  return { repo: value.repo, taskId: value.task_id, runId: value.run_id };
}

function scheduledTaskHref(repo: string): string {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) return "#";
  const owner = encodeURIComponent(repo.slice(0, slash));
  const name = encodeURIComponent(repo.slice(slash + 1));
  return `/r/${owner}/${name}/scheduled-tasks`;
}

function sourceView(value: InboxJsonObject | null): ReactNode {
  const scheduled = scheduledTaskSource(value);
  if (!scheduled) return compactJson(value);
  return (
    <span className="flex flex-col gap-0.5">
      <span>kind:scheduled_task repo:{scheduled.repo}</span>
      <span>
        <a
          className="text-primary underline-offset-2 hover:underline"
          href={scheduledTaskHref(scheduled.repo)}
        >
          Scheduled task #{scheduled.taskId}
        </a>{" "}
        run #{scheduled.runId}
      </span>
    </span>
  );
}

function bodySummary(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function stateTone(state: InboxMessage["state"]): "open" | "closed" {
  return state === "unread" ? "open" : "closed";
}

export function InboxPage() {
  const [view, setView] = useState<"active" | "archived">("active");
  const { experimental } = useWebConfig();
  const queryInput =
    view === "archived"
      ? ({ state: "archived", limit: 100 } as const)
      : ({ limit: 100 } as const);
  const { data, isLoading, isError } = useInboxMessages(queryInput);
  const visibleMessages = experimental
    ? data
    : data?.filter((message) => scheduledTaskSource(message.from) == null);

  return (
    <div data-debug-component="InboxPage" className="flex w-full flex-col">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <div className="inline-flex rounded-md border bg-background p-1">
          <Button
            type="button"
            variant={view === "active" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("active")}
          >
            Active
          </Button>
          <Button
            type="button"
            variant={view === "archived" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("archived")}
          >
            Archived
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading...
        </div>
      )}
      {isError && (
        <div className="mt-6 text-sm text-destructive">
          Failed to load Inbox messages.
        </div>
      )}
      {visibleMessages && visibleMessages.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">
          No {view === "archived" ? "archived" : "active"} Inbox messages.
        </p>
      )}
      {visibleMessages && visibleMessages.length > 0 && (
        <InboxTable messages={visibleMessages} view={view} />
      )}
    </div>
  );
}

function InboxTable({
  messages,
  view,
}: {
  messages: InboxMessage[];
  view: "active" | "archived";
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const action = useInboxMessageAction();

  function toggle(id: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div data-debug-component="InboxTable" className="mt-6 overflow-x-auto">
      <table className="min-w-[1120px] w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase text-muted-foreground">
            <th className="w-10 px-2 py-2 font-medium">
              <span className="sr-only">Expand</span>
            </th>
            <th className="px-3 py-2 font-medium">Repo</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 font-medium">To</th>
            <th className="px-3 py-2 font-medium">Label</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium">Message</th>
            <th className="w-[128px] px-3 py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {messages.map((message) => {
            const isExpanded = expanded.has(message.id);
            return (
              <MessageRows
                key={message.id}
                message={message}
                expanded={isExpanded}
                onToggle={() => toggle(message.id)}
                view={view}
                onAction={(nextAction) =>
                  action.mutate({ id: message.id, action: nextAction })
                }
                actionPending={action.isPending}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MessageRows({
  message,
  expanded,
  onToggle,
  view,
  onAction,
  actionPending,
}: {
  message: InboxMessage;
  expanded: boolean;
  onToggle: () => void;
  view: "active" | "archived";
  onAction: (
    action: "read" | "unread" | "archive" | "unarchive" | "delete",
  ) => void;
  actionPending: boolean;
}) {
  return (
    <>
      <tr
        data-debug-component="InboxMessageRow"
        className={cn(
          "border-b align-top last:border-b-0",
          message.state === "unread" && "bg-primary-subtle/40",
        )}
      >
        <td className="px-2 py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={
              expanded
                ? `Hide message body: ${message.title}`
                : `Show message body: ${message.title}`
            }
            aria-expanded={expanded}
            onClick={onToggle}
            className="size-7"
          >
            {expanded ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-4" aria-hidden="true" />
            )}
          </Button>
        </td>
        <td className="max-w-[180px] break-words px-3 py-2 font-medium">
          {message.repo.name || "-"}
        </td>
        <td className="max-w-[170px] break-words px-3 py-2 text-xs">
          {sourceView(message.from)}
        </td>
        <td className="max-w-[150px] break-words px-3 py-2 text-xs text-muted-foreground">
          {compactJson(message.to)}
        </td>
        <td className="px-3 py-2">
          {message.label ? <Badge tone="agent">{message.label}</Badge> : "-"}
        </td>
        <td className="px-3 py-2">
          <Badge tone={stateTone(message.state)}>{message.state}</Badge>
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
          <time dateTime={message.created_at}>
            {relativeTime(message.created_at) || message.created_at}
          </time>
        </td>
        <td className="min-w-[320px] px-3 py-2">
          <div
            className={cn(
              "font-medium",
              message.state === "read" && "text-muted-foreground",
            )}
          >
            {message.title}
          </div>
          <div className="mt-1 break-words text-xs text-muted-foreground">
            {bodySummary(message.body)}
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center justify-end gap-1">
            {view === "archived" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={actionPending}
                aria-label={`Unarchive message: ${message.title}`}
                onClick={() => onAction("unarchive")}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={actionPending}
                  aria-label={
                    message.state === "unread"
                      ? `Mark message read: ${message.title}`
                      : `Mark message unread: ${message.title}`
                  }
                  onClick={() =>
                    onAction(message.state === "unread" ? "read" : "unread")
                  }
                >
                  {message.state === "unread" ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <Mail className="size-4" aria-hidden="true" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={actionPending}
                  aria-label={`Archive message: ${message.title}`}
                  onClick={() => onAction("archive")}
                >
                  <Archive className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={actionPending}
                  aria-label={`Delete message: ${message.title}`}
                  onClick={() => onAction("delete")}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </>
            )}
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr
          data-debug-component="InboxMessageDetails"
          className="border-b bg-muted/30 align-top"
        >
          <td />
          <td colSpan={8} className="px-3 py-3">
            <pre className="whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-sm leading-6">
              {message.body}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
