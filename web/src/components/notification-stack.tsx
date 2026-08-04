import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Info,
  Terminal,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Notification } from "@/api/types";
import { useToast } from "@/components/toast";
import { YesNoPrompt } from "@/components/yes-no-prompt";
import { formatCost } from "@/lib/session-usage";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  useNotifications,
  useReadAllNotifications,
  useReadNotification,
} from "@/queries/notifications";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";
import {
  useIncreaseWorkflowRunCostLimit,
  useWorkflowRunForPull,
} from "@/queries/workflow-runs";

const MAX_VISIBLE_NOTIFICATIONS = 5;
const STACK_ITEM_CLASSES =
  "pointer-events-auto rounded-md border bg-background p-3 text-sm text-foreground shadow-lg";

function notificationIcon(notification: Notification) {
  if (notification.severity === "warning") return AlertTriangle;
  const kind = notification.kind;
  if (kind === "merge_ready") return CheckCircle2;
  if (kind === "over_budget") return CircleDollarSign;
  if (kind === "human_attention") return Info;
  return AlertTriangle;
}

function notificationTone(notification: Notification): string {
  if (notification.severity === "warning") {
    return "text-amber-700 dark:text-amber-300";
  }
  const kind = notification.kind;
  if (kind === "merge_ready") return "text-emerald-700 dark:text-emerald-300";
  if (kind === "over_budget") return "text-amber-700 dark:text-amber-300";
  if (kind === "human_attention") return "text-sky-700 dark:text-sky-300";
  return "text-rose-700 dark:text-rose-300";
}

// The run a cost-limit notification is about, or null when the notification is not one. A
// run-scoped over-budget notification is the only place the stack offers an action on the run
// itself, so the kind and the run id decide it — never the generated title.
function costHeldWorkflowRun(notification: Notification): number | null {
  if (notification.kind !== "over_budget") return null;
  if (notification.resource.kind !== "pull") return null;
  return notification.workflow_run_id;
}

function resourceLabel(notification: Notification): string {
  const number = notification.resource.number;
  if (notification.resource.kind === "pull" && number != null) {
    return `PR #${number}`;
  }
  if (notification.resource.kind === "issue" && number != null) {
    return `Issue #${number}`;
  }
  return "Repository";
}

export function NotificationStack() {
  const { data, isError } = useNotifications({ unreadOnly: true });
  const readNotification = useReadNotification();
  const readAllNotifications = useReadAllNotifications();
  const focus = useFocusHerdrAgent();
  const herdrSessions = useHerdrSessions();
  const { showError } = useToast();
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  const visible = useMemo(
    () =>
      (data ?? [])
        .filter(
          (notification) =>
            notification.read_at == null && !dismissedIds.has(notification.id),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
        .slice(0, MAX_VISIBLE_NOTIFICATIONS),
    [data, dismissedIds],
  );

  function markRead(notification: Notification) {
    setDismissedIds((ids) => new Set(ids).add(notification.id));
    readNotification.mutate(notification.id, {
      onSuccess: () => {
        setDismissedIds((ids) => {
          const next = new Set(ids);
          next.delete(notification.id);
          return next;
        });
      },
      onError: (error) => {
        setDismissedIds((ids) => {
          const next = new Set(ids);
          next.delete(notification.id);
          return next;
        });
        showError(
          error instanceof Error
            ? error.message
            : "Failed to mark notification read.",
        );
      },
    });
  }

  function clearAll() {
    if (visible.length === 0 || readAllNotifications.isPending) return;
    readAllNotifications.mutate(undefined, {
      onError: (error) =>
        showError(
          error instanceof Error
            ? error.message
            : "Failed to clear notifications.",
        ),
    });
  }

  function herdrPaneId(notification: Notification): string | null {
    const repo = herdrSessions.data?.repos.find(
      (group) => group.repo === notification.repo.name,
    );
    if (notification.herdr_pane_id) {
      const paneId = notification.herdr_pane_id;
      const paneIsLive =
        repo?.agents.some((agent) => agent.id === paneId) ||
        repo?.pull_workspaces.some(
          (workspace) => workspace.pane_id === paneId,
        ) ||
        repo?.issue_workspaces?.some(
          (workspace) => workspace.pane_id === paneId,
        );
      return paneIsLive ? paneId : null;
    }
    if (
      notification.resource.kind !== "pull" ||
      notification.resource.number == null
    ) {
      return null;
    }
    return (
      repo?.pull_workspaces.find(
        (workspace) => workspace.pull === notification.resource.number,
      )?.pane_id ?? null
    );
  }

  function focusHerdr(notification: Notification, paneId: string) {
    focus.mutate(
      { repo: notification.repo.name, paneId },
      {
        onError: (error) =>
          showError(
            error instanceof Error ? error.message : "Failed to open in Herdr.",
          ),
      },
    );
  }

  if (!isError && visible.length === 0) return null;

  return (
    <section
      aria-label="Unread notifications"
      aria-live="polite"
      data-debug-component="NotificationStack"
      className="pointer-events-none fixed right-4 bottom-12 z-40 flex max-h-[calc(100vh-4rem)] w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto"
    >
      {visible.length > 0 ? (
        <div className="pointer-events-auto flex justify-end">
          <button
            type="button"
            onClick={clearAll}
            disabled={readAllNotifications.isPending}
            className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear all
          </button>
        </div>
      ) : null}
      {isError ? (
        <div
          role="alert"
          className={`${STACK_ITEM_CLASSES} flex items-start gap-3 border-destructive/50 text-destructive`}
        >
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span>Failed to load notifications.</span>
        </div>
      ) : null}
      {visible.map((notification) => (
        <NotificationItem
          key={notification.id}
          notification={notification}
          onRead={() => markRead(notification)}
          herdrPaneId={herdrPaneId(notification)}
          onFocusHerdr={(paneId) => focusHerdr(notification, paneId)}
          herdrPending={focus.isPending}
        />
      ))}
    </section>
  );
}

function NotificationItem({
  notification,
  onRead,
  onFocusHerdr,
  herdrPaneId,
  herdrPending,
}: {
  notification: Notification;
  onRead: () => void;
  onFocusHerdr: (paneId: string) => void;
  herdrPaneId: string | null;
  herdrPending: boolean;
}) {
  const Icon = notificationIcon(notification);
  const label = resourceLabel(notification);
  const costHeldRun = costHeldWorkflowRun(notification);
  return (
    <article
      data-debug-component="NotificationItem"
      data-severity={notification.severity}
      className={cn(STACK_ITEM_CLASSES, "flex items-start gap-3")}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", notificationTone(notification))}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <Link
          to={notification.resource.href}
          onClick={onRead}
          className="block rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <div className="truncate font-medium">{notification.title}</div>
          {notification.resource.kind === "pull" &&
          notification.resource.title ? (
            <div className="truncate text-xs text-muted-foreground">
              {notification.resource.title}
            </div>
          ) : null}
          <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">
            {notification.body}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{notification.repo.name}</span>
            <span aria-hidden="true">/</span>
            <span>{label}</span>
            <time
              className="ml-auto shrink-0"
              dateTime={notification.created_at}
            >
              {relativeTime(notification.created_at)}
            </time>
          </div>
        </Link>
        {costHeldRun != null && notification.resource.number != null ? (
          <WorkflowBudgetAction
            repo={notification.repo.name}
            pull={notification.resource.number}
            run={costHeldRun}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 self-stretch flex-col justify-between gap-2">
        <button
          type="button"
          aria-label={`Close ${notification.title}`}
          title="Mark as read"
          onClick={onRead}
          className="rounded p-0.5 text-muted-foreground opacity-70 hover:bg-accent hover:text-accent-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
        {herdrPaneId ? (
          <button
            type="button"
            title="Open in Herdr"
            aria-label={`Open ${label} in Herdr`}
            disabled={herdrPending}
            onClick={() => onFocusHerdr(herdrPaneId)}
            className="inline-flex size-5 items-center justify-center self-center rounded-md border border-zinc-400 bg-zinc-500 text-zinc-50 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <Terminal className="size-2.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </article>
  );
}

// Raises the limit of the cost-held run the notification is about, so a supervisor who is only
// watching the stack answers the hold where they read it instead of opening the PR (#2358). The
// increase is the same one the PR row offers: the run's persisted increment, guarded by the limit
// the notification's run currently sits at. Nothing renders while the run is not held — a run
// resumed elsewhere leaves an already-read-looking notification behind, not a dead action.
function WorkflowBudgetAction({
  repo,
  pull,
  run,
}: {
  repo: string;
  pull: number;
  run: number;
}) {
  const [owner, name] = repo.split("/");
  const { data: state } = useWorkflowRunForPull(owner, name, pull);
  const increaseCostLimit = useIncreaseWorkflowRunCostLimit(owner, name, pull);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [increasedLimitUsd, setIncreasedLimitUsd] = useState<number | null>(
    null,
  );

  // The answered question stays as the outcome: the action is gone, and the limit it moved to is
  // the confirmation. Only the run state can bring the question back, at the next crossing.
  if (increasedLimitUsd !== null) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Cost limit increased to {formatCost(increasedLimitUsd)}.
      </p>
    );
  }
  if (!state || state.id !== run || !state.cost_limit_increase_available) {
    return null;
  }
  const nextLimit = state.cost_limit_usd + state.cost_increment_usd;
  return (
    <div className="mt-2 flex flex-col items-start gap-1 text-xs">
      {asking ? (
        <YesNoPrompt
          question={`Increase to ${formatCost(nextLimit)}?`}
          pending={increaseCostLimit.isPending}
          onYes={() =>
            increaseCostLimit.mutate(
              { run: state.id, expectedLimitUsd: state.cost_limit_usd },
              {
                onSuccess: (result) => {
                  setError(null);
                  setIncreasedLimitUsd(result.current_limit_usd);
                },
                onError: (failure) =>
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Failed to increase the workflow budget.",
                  ),
              },
            )
          }
          onNo={() => {
            setAsking(false);
            setError(null);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="rounded-md border px-2 py-0.5 font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Increase cost limit
        </button>
      )}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
