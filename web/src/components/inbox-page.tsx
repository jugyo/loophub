import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import type { InboxJsonObject, InboxMessage } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useInboxMessages } from "@/queries/inbox";

function compactJson(value: InboxJsonObject | null): string {
  if (!value) return "-";
  const preferred = ["actor", "kind", "repo", "task_id", "run_id"];
  const parts = preferred
    .filter((key) => value[key] != null)
    .map((key) => `${key}:${String(value[key])}`);
  if (parts.length > 0) return parts.join(" ");
  return JSON.stringify(value);
}

function bodySummary(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function stateTone(state: InboxMessage["state"]): "open" | "closed" {
  return state === "unread" ? "open" : "closed";
}

export function InboxPage() {
  const { data, isLoading, isError } = useInboxMessages({ limit: 100 });

  return (
    <div className="flex w-full flex-col">
      <h1 className="text-2xl font-semibold">Inbox</h1>

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
      {data && data.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">No Inbox messages.</p>
      )}
      {data && data.length > 0 && <InboxTable messages={data} />}
    </div>
  );
}

function InboxTable({ messages }: { messages: InboxMessage[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  function toggle(id: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="mt-6 overflow-x-auto">
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
}: {
  message: InboxMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
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
          {compactJson(message.from)}
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
          <div className="font-medium">{message.title}</div>
          <div className="mt-1 break-words text-xs text-muted-foreground">
            {bodySummary(message.body)}
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b bg-muted/30 align-top">
          <td />
          <td colSpan={7} className="px-3 py-3">
            <pre className="whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-sm leading-6">
              {message.body}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
