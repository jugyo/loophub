// PR-detail Agents section: every live Herdr pane whose cwd resolves to this PR, enriched by core
// with Workflow parent/child metadata and persisted LoopHub session usage. Pane rows stay compact;
// hover or keyboard focus reveals the full metadata and the existing focus action.

import { Bot, Loader2, Terminal } from "lucide-react";
import type { HerdrAgent } from "@/api/types";
import { herdrWorkspaceBadgeIconClass } from "@/components/herdr-badge";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { formatCost, formatTokenCount } from "@/lib/session-usage";
import { useHoverPopover } from "@/lib/use-hover-popover";
import { cn } from "@/lib/utils";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

function statusTextClass(status: string): string {
  switch (status) {
    case "blocked":
      return "text-red-500";
    case "working":
      return "text-yellow-500";
    case "done":
      return "text-blue-500";
    case "idle":
      return "text-green-500";
    default:
      return "text-muted-foreground";
  }
}

interface AgentTreeRow {
  agent: HerdrAgent;
  depth: 0 | 1;
}

function agentTree(agents: HerdrAgent[]): AgentTreeRow[] {
  const rows: AgentTreeRow[] = [];
  const added = new Set<string>();
  for (const agent of agents) {
    if (agent.workflow?.kind === "step") continue;
    rows.push({ agent, depth: 0 });
    added.add(agent.id);
    if (agent.workflow?.kind !== "parent") continue;
    const children = agents
      .filter(
        (candidate) =>
          !added.has(candidate.id) &&
          candidate.workflow?.kind === "step" &&
          candidate.workflow.runId === agent.workflow?.runId,
      )
      .sort((a, b) => {
        const aSequence = a.workflow?.kind === "step" ? a.workflow.sequence : 0;
        const bSequence = b.workflow?.kind === "step" ? b.workflow.sequence : 0;
        return aSequence - bSequence;
      });
    for (const child of children) {
      rows.push({ agent: child, depth: 1 });
      added.add(child.id);
    }
  }
  for (const agent of agents) {
    if (!added.has(agent.id)) rows.push({ agent, depth: 0 });
  }
  return rows;
}

export function PullHerdrSection({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: number;
}) {
  const { data, isError } = useHerdrSessions();
  if (isError) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Agents</h2>
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          Failed to load Agents.
        </div>
      </section>
    );
  }
  const group = data?.repos?.find(
    (candidate) => candidate.repo === `${owner}/${repo}`,
  );
  const agents = group?.agents.filter((agent) => agent.pull === pull) ?? [];
  if (!group || agents.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Agents</h2>
      <ol
        aria-label="Agent hierarchy"
        className="flex flex-col rounded-md border p-2 text-sm"
      >
        {agentTree(agents).map(({ agent, depth }) => (
          <AgentRow
            key={agent.id}
            owner={owner}
            repo={repo}
            agent={agent}
            depth={depth}
          />
        ))}
      </ol>
    </section>
  );
}

function AgentRow({
  owner,
  repo,
  agent,
  depth,
}: {
  owner: string;
  repo: string;
  agent: HerdrAgent;
  depth: 0 | 1;
}) {
  const popover = useHoverPopover();
  const focus = useFocusHerdrAgent();
  const { showError } = useToast();
  const usage = agent.session?.usage;
  const cost = formatCost(usage?.cost_usd ?? null);

  return (
    <li
      data-depth={depth}
      className={cn("relative", depth === 1 && "ml-5 border-l pl-2")}
      onMouseEnter={popover.onMouseEnter}
      onMouseLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        popover.onMouseLeave();
      }}
      onFocus={popover.onFocus}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) popover.close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") popover.close();
      }}
    >
      <div
        tabIndex={0}
        className="flex items-center gap-2 rounded px-2 py-2 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bot
          className={cn(
            "size-4 shrink-0 text-muted-foreground",
            herdrWorkspaceBadgeIconClass(agent.status),
          )}
        />
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={agent.name}
        >
          {agent.name}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {cost}
        </span>
      </div>

      {popover.open ? (
        <div className="absolute right-0 top-full z-30 w-72 pt-1">
          <div
            role="dialog"
            aria-label={`${agent.name} agent details`}
            className="rounded-md border bg-background p-3 text-foreground shadow-lg"
          >
            <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
              <AgentDetail label="Pane title" value={agent.name} />
              <AgentDetail
                label="Agent"
                value={
                  agent.session
                    ? [agent.session.agent, agent.session.runtime]
                        .filter(Boolean)
                        .join(" · ")
                    : "n/a"
                }
              />
              <AgentDetail
                label="Status"
                value={agent.status || "n/a"}
                valueClassName={statusTextClass(agent.status)}
              />
              <AgentDetail
                label="Session ID"
                value={agent.session?.id ?? "n/a"}
              />
              <AgentDetail
                label="Token usage"
                value={
                  usage && usage.sessions_with_usage > 0
                    ? formatTokenCount(usage.total_tokens)
                    : "n/a"
                }
              />
              <AgentDetail label="Cost" value={cost} />
            </dl>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3 h-8"
              disabled={!agent.focusable || focus.isPending}
              title={
                agent.focusable
                  ? "Focus this pane in Herdr"
                  : "This agent has no focusable Herdr pane"
              }
              onClick={() =>
                focus.mutate(
                  { repo: `${owner}/${repo}`, paneId: agent.id },
                  {
                    onError: (error) =>
                      showError(
                        error instanceof Error
                          ? error.message
                          : "Failed to open in Herdr.",
                      ),
                  },
                )
              }
            >
              {focus.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Terminal className="size-3.5" />
              )}
              Open in Herdr
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function AgentDetail({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn("min-w-0 truncate font-medium", valueClassName)}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
