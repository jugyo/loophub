import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { AgentSession, SessionLinkedTarget } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import {
  formatCost,
  formatTokenCount,
  modelLabel,
  totalTokens,
  usageCost,
  usageTotal,
} from "@/lib/session-usage";
import { relativeTime } from "@/lib/time";
import { useAgentSessions } from "@/queries/sessions";

export { formatCost, formatTokenCount } from "@/lib/session-usage";

function targetHref(target: SessionLinkedTarget): string {
  const [owner, repo] = target.repo.split("/");
  return `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${target.kind === "pull" ? "pulls" : "issues"}/${target.number}`;
}

function targetLabel(target: SessionLinkedTarget): string {
  return `${target.kind === "pull" ? "PR" : "Issue"} #${target.number}`;
}

function updatedTime(session: AgentSession): number {
  const ms = Date.parse(session.updated_at);
  return Number.isFinite(ms) ? ms : 0;
}

export function AgentSessionsPage() {
  const { data, isLoading, isError } = useAgentSessions();

  return (
    <div className="mx-auto max-w-content">
      <h1 className="text-2xl font-semibold">Agent sessions</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Latest registered sessions, usage, API-equivalent cost, and linked work.
      </p>

      {isLoading && (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      )}
      {isError && (
        <div className="mt-6 text-sm text-destructive">
          Failed to load agent sessions.
        </div>
      )}
      {data && data.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">No agent sessions.</p>
      )}
      {data && data.length > 0 && <SessionsTable sessions={data} />}
    </div>
  );
}

function SessionsTable({ sessions }: { sessions: AgentSession[] }) {
  const sortedSessions = [...sessions].sort(
    (a, b) => updatedTime(b) - updatedTime(a),
  );

  return (
    <div className="mt-6 overflow-x-auto">
      <table className="min-w-[1040px] w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase text-muted-foreground">
            <th className="px-3 py-2 font-medium">Session</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 text-right font-medium">Input</th>
            <th className="px-3 py-2 text-right font-medium">Cache write</th>
            <th className="px-3 py-2 text-right font-medium">Cache read</th>
            <th className="px-3 py-2 text-right font-medium">Output</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            <th className="px-3 py-2 font-medium">Effort</th>
            <th className="px-3 py-2 font-medium">Linked work</th>
            <th className="px-3 py-2 text-right font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {sortedSessions.map((session) => {
            const hasUsage = (session.usage?.length ?? 0) > 0;
            const total = usageTotal(session.usage);
            return (
              <tr
                key={session.id}
                className="border-b align-top last:border-b-0"
              >
                <td className="max-w-[220px] px-3 py-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="agent">{session.kind ?? "session"}</Badge>
                      <span className="break-words font-medium">
                        {session.name ?? session.agent}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{session.agent}</span>
                      {session.runtime ? (
                        <code className="rounded bg-muted px-1 py-0.5">
                          {session.runtime}
                        </code>
                      ) : null}
                    </div>
                  </div>
                </td>
                <td className="max-w-[180px] break-words px-3 py-2 text-xs">
                  {modelLabel(session.usage)}
                </td>
                <UsageCell value={hasUsage ? total.input_tokens : null} />
                <UsageCell
                  value={hasUsage ? total.cache_creation_input_tokens : null}
                />
                <UsageCell
                  value={hasUsage ? total.cache_read_input_tokens : null}
                />
                <UsageCell value={hasUsage ? total.output_tokens : null} />
                <UsageCell value={hasUsage ? totalTokens(total) : null} />
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCost(usageCost(session.usage))}
                </td>
                <td className="px-3 py-2 text-muted-foreground">n/a</td>
                <td className="max-w-[240px] px-3 py-2">
                  <LinkedTargets targets={session.linked_targets} />
                </td>
                <td
                  className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                  title={session.updated_at}
                >
                  {relativeTime(session.updated_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UsageCell({ value }: { value: number | null }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      {value === null ? "n/a" : formatTokenCount(value)}
    </td>
  );
}

function LinkedTargets({
  targets,
}: {
  targets: SessionLinkedTarget[] | undefined;
}) {
  if (!targets || targets.length === 0)
    return <span className="text-muted-foreground">n/a</span>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {targets.map((target) => (
        <Link
          key={`${target.repo}:${target.kind}:${target.number}`}
          to={targetHref(target)}
          title={`${target.repo}: ${target.title}`}
          className="rounded border px-1.5 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
        >
          {targetLabel(target)}
        </Link>
      ))}
    </div>
  );
}
