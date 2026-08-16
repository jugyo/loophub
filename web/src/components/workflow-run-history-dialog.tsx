import { ChevronRight, Loader2, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type {
  WorkflowRunAgentCost,
  WorkflowRunHistoryEvent,
  WorkflowRunState,
} from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCost } from "@/lib/session-usage";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import {
  workflowDisplayStage,
  workflowRunDisplayState,
} from "@/lib/workflow-run";
import {
  useWorkflowRunAgentCosts,
  useWorkflowRunHistory,
} from "@/queries/workflow-runs";

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  // Legacy terminal status (#1307): shown like a needs-human run.
  blocked: "Needs human",
  completed: "Completed",
  stopped: "Stopped",
};

// A running run holding a needs-human reason is waiting for a human (#1307) — surface that over
// the plain status, matching the run-status section's badge.
function statusLabel(state: WorkflowRunState): string {
  const stage = workflowDisplayStage(state);
  if (stage === "merged") return "Merged";
  if (stage === "ready_to_merge") return "Ready to merge";
  if (state.status === "running" && state.needs_human_reason !== null) {
    return "Needs human";
  }
  return STATUS_LABELS[state.status] ?? state.status;
}

function displayName(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

function currentStepLabel(state: WorkflowRunState): string {
  const stage = workflowDisplayStage(state);
  if (stage === "merged") return "Merged";
  if (stage === "ready_to_merge") return "Ready to merge";
  return displayName(state.current_step);
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function WorkflowRunDetailDialog({
  owner,
  repo,
  state,
  onClose,
}: {
  owner: string;
  repo: string;
  state: WorkflowRunState;
  onClose: () => void;
}) {
  const displayState = workflowRunDisplayState(state);
  const history = useWorkflowRunHistory(owner, repo, state.id, true);
  const agents = useWorkflowRunAgentCosts(owner, repo, state.id, true);
  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portal to the body so the overlay's z-50 is compared against the app shell's own layers
  // (the toast viewport's z-40, a detail page's sticky header at z-20) instead of against its
  // siblings inside whichever section rendered it. The PR sidebar is a sticky box (#2348), and
  // sticky creates a stacking context regardless of z-index, which would otherwise trap this
  // modal below those layers.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-4"
      {...backdropDismiss}
    >
      <div
        data-debug-component="WorkflowRunDetailDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Workflow run ${state.id} detail`}
        className="flex w-full max-w-4xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">
              {state.workflow_name ?? "Workflow"} · run {state.id}
            </h2>
            <p className="text-sm text-muted-foreground">
              Activity and agent costs for this Workflow run
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close Workflow run detail"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          <dl className="grid grid-cols-4 gap-x-6 gap-y-4 rounded-md border bg-muted/20 p-4 text-sm">
            <Metadata
              label="Workflow"
              value={state.workflow_name ?? "Workflow"}
            />
            <Metadata label="Run" value={String(state.id)} />
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="mt-1">
                <Badge>{statusLabel(displayState)}</Badge>
              </dd>
            </div>
            <Metadata
              label="Current step"
              value={currentStepLabel(displayState)}
            />
            <Metadata
              label="Rework"
              value={`${state.rework_count}/${state.rework_limit}`}
            />
            <Metadata
              label="Started"
              value={timestamp(state.created_at)}
              dateTime={state.created_at}
            />
            <Metadata
              label="Updated"
              value={timestamp(state.updated_at)}
              dateTime={state.updated_at}
            />
          </dl>

          <section
            data-debug-component="WorkflowRunAgentCosts"
            className="mt-6"
            aria-labelledby="workflow-run-agent-costs-heading"
          >
            <h3
              id="workflow-run-agent-costs-heading"
              className="text-sm font-semibold"
            >
              Agents
            </h3>
            <div className="mt-3">
              {agents.isLoading ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading agent
                  costs…
                </div>
              ) : agents.isError ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
                  Failed to load agent costs.
                  {agents.error instanceof Error
                    ? ` ${agents.error.message}`
                    : null}
                </div>
              ) : agents.data?.length ? (
                <div className="overflow-hidden rounded-md border">
                  <div className="grid grid-cols-[minmax(0,1fr)_8rem_9rem] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
                    <span>Role</span>
                    <span>Sessions</span>
                    <span className="text-right">Cost</span>
                  </div>
                  <ol className="divide-y">
                    {agents.data.map((agent) => (
                      <AgentCostRow key={agent.role} agent={agent} />
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No agent sessions have been recorded for this run.
                </p>
              )}
            </div>
          </section>

          <section
            data-debug-component="WorkflowRunHistory"
            className="mt-6"
            aria-labelledby="workflow-run-history-heading"
          >
            <h3
              id="workflow-run-history-heading"
              className="text-sm font-semibold"
            >
              Activity
            </h3>
            <div className="mt-3">
              {history.isLoading ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading Workflow
                  run history…
                </div>
              ) : history.isError ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
                  Failed to load Workflow run history.
                  {history.error instanceof Error
                    ? ` ${history.error.message}`
                    : null}
                </div>
              ) : history.data?.length ? (
                <ol className="relative ml-2 border-l pl-5">
                  {history.data.map((event) => (
                    <HistoryEntry key={event.id} event={event} />
                  ))}
                </ol>
              ) : (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No lifecycle events have been recorded for this run.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function groupedAgentCost(agent: WorkflowRunAgentCost): string {
  if (agent.known_session_count > 0) {
    const cost = formatCost(agent.cost_usd);
    return agent.pending_session_count > 0 || agent.unknown_session_count > 0
      ? `${cost} known`
      : cost;
  }
  if (agent.pending_session_count > 0 && agent.unknown_session_count > 0) {
    return "Incomplete";
  }
  return agent.pending_session_count > 0 ? "Pending" : "Unknown";
}

function AgentCostRow({ agent }: { agent: WorkflowRunAgentCost }) {
  const incomplete = [
    agent.pending_session_count > 0
      ? `${agent.pending_session_count} pending`
      : null,
    agent.unknown_session_count > 0
      ? `${agent.unknown_session_count} unknown`
      : null,
  ].filter((value): value is string => value !== null);

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_8rem_9rem] items-center gap-3 px-4 py-3 text-sm">
      <div className="font-medium">{displayName(agent.role)}</div>
      <div className="text-muted-foreground tabular-nums">
        {agent.session_count}{" "}
        {agent.session_count === 1 ? "session" : "sessions"}
      </div>
      <div className="text-right tabular-nums">
        <div className="font-medium">{groupedAgentCost(agent)}</div>
        {incomplete.length > 0 ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {incomplete.join(" · ")}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Metadata({
  label,
  value,
  dateTime,
}: {
  label: string;
  value: string;
  dateTime?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">
        {dateTime ? <time dateTime={dateTime}>{value}</time> : value}
      </dd>
    </div>
  );
}

// Each significance the wire can carry (#1867) gets one look. The notable and default rows differ
// by dot size and by title size/weight, not by color alone, so the ranking survives a monochrome
// or color-blind read.
const ENTRY_STYLES: Record<
  Exclude<WorkflowRunHistoryEvent["significance"], "routine">,
  { dot: string; title: string }
> = {
  notable: {
    dot: "-left-[1.675rem] size-3 bg-primary",
    title: "text-base font-semibold",
  },
  default: {
    dot: "-left-[1.55rem] size-2 bg-muted-foreground/60",
    title: "text-sm font-medium",
  },
};

function HistoryEntry({ event }: { event: WorkflowRunHistoryEvent }) {
  // Routine loop mechanics (#1851) recede to one dim line — the timeline stays complete, but the
  // per-turn bookkeeping stops crowding out the lifecycle events between them. Their description
  // only restates the label, and their type / step / actor repeat on every row.
  if (event.significance === "routine") {
    return (
      <li
        data-debug-component="WorkflowRunHistoryEntry"
        data-significance="routine"
        className="relative pb-3 last:pb-0"
      >
        <span className="absolute -left-[1.55rem] top-1.5 size-2 rounded-full bg-muted-foreground/30 ring-4 ring-background" />
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{event.label}</span>
          <time dateTime={event.created_at}>{timestamp(event.created_at)}</time>
        </div>
      </li>
    );
  }
  const style = ENTRY_STYLES[event.significance];
  return (
    <li
      data-debug-component="WorkflowRunHistoryEntry"
      data-significance={event.significance}
      className="relative pb-5 last:pb-0"
    >
      <span
        className={`absolute top-1.5 rounded-full ring-4 ring-background ${style.dot}`}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className={style.title}>{event.label}</h4>
        <time
          dateTime={event.created_at}
          className="text-xs text-muted-foreground"
        >
          {timestamp(event.created_at)}
        </time>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{event.description}</p>
      {event.input ? (
        // Agent input can be a long launch prompt; keep it collapsed by default so it does not
        // crowd out the surrounding lifecycle events, and let a reader expand it on demand.
        <details
          data-debug-component="WorkflowRunHistoryEntryInput"
          className="group mt-2 overflow-hidden rounded-md border bg-muted/30"
        >
          <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            Agent input
          </summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t px-3 py-2 font-sans text-xs leading-relaxed text-muted-foreground">
            {event.input}
          </pre>
        </details>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <code>{event.type}</code>
        <span>Step: {event.step ? displayName(event.step) : "N/A"}</span>
        <span>Actor: {event.actor}</span>
      </div>
    </li>
  );
}
