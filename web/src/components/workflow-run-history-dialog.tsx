import { Loader2, X } from "lucide-react";
import { useEffect } from "react";
import type { WorkflowRunHistoryEvent, WorkflowRunState } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWorkflowRunHistory } from "@/queries/workflow-runs";

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

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function WorkflowRunHistoryDialog({
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
  const history = useWorkflowRunHistory(owner, repo, state.id, true);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        data-debug-component="WorkflowRunHistoryDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Workflow run #${state.id} history`}
        className="flex w-full max-w-4xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">
              {state.workflow_name ?? "Workflow"} · run #{state.id}
            </h2>
            <p className="text-sm text-muted-foreground">
              Lifecycle history for this Workflow run
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close Workflow run history"
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
            <Metadata label="Run" value={`#${state.id}`} />
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="mt-1">
                <Badge>{statusLabel(state)}</Badge>
              </dd>
            </div>
            <Metadata
              label="Current step"
              value={displayName(state.current_step)}
            />
            <Metadata label="Rework count" value={String(state.rework_count)} />
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
    </div>
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

function HistoryEntry({ event }: { event: WorkflowRunHistoryEvent }) {
  return (
    <li
      data-debug-component="WorkflowRunHistoryEntry"
      className="relative pb-5 last:pb-0"
    >
      <span className="absolute -left-[1.55rem] top-1.5 size-2 rounded-full bg-primary ring-4 ring-background" />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-medium">{event.label}</h4>
        <time
          dateTime={event.created_at}
          className="text-xs text-muted-foreground"
        >
          {timestamp(event.created_at)}
        </time>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{event.description}</p>
      {event.input ? (
        <div className="mt-2 max-h-40 overflow-auto rounded-md border bg-muted/30 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            Agent input
          </p>
          <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
            {event.input}
          </pre>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <code>{event.type}</code>
        <span>Step: {event.step ? displayName(event.step) : "N/A"}</span>
        <span>Actor: {event.actor}</span>
      </div>
    </li>
  );
}
