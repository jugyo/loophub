import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ExternalLink,
  Info,
  MessageSquare,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Notification } from "@/api/types";
import { useToast } from "@/components/toast";
import { YesNoPrompt } from "@/components/yes-no-prompt";
import {
  getNotificationsMinimized,
  setNotificationsMinimized,
} from "@/lib/notification-minimize";
import { formatCost } from "@/lib/session-usage";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  useNotifications,
  useReadAllNotifications,
  useReadNotification,
} from "@/queries/notifications";
import {
  useIncreaseWorkflowRunCostLimit,
  useIncreaseWorkflowRunReworkLimit,
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
  if (kind === "agent_comment") return MessageSquare;
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
  if (kind === "agent_comment") return "text-violet-700 dark:text-violet-300";
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

function reworkHeldWorkflowRun(notification: Notification): number | null {
  if (notification.kind !== "human_attention") return null;
  if (!notification.body.toLowerCase().includes("rework limit")) return null;
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

function notificationKindLabel(notification: Notification): string {
  if (notification.kind === "merge_ready") return "Merge ready";
  if (notification.kind === "over_budget") return "Over budget";
  if (notification.kind === "human_attention") return "Human attention";
  if (notification.kind === "agent_comment") return "Agent comment";
  return "Notification";
}

export function NotificationStack() {
  const { data, isError } = useNotifications({ unreadOnly: true });
  const readNotification = useReadNotification();
  const readAllNotifications = useReadAllNotifications();
  const { showError } = useToast();
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  const [minimized, setMinimized] = useState(getNotificationsMinimized);
  const unread = useMemo(
    () =>
      (data ?? [])
        .filter(
          (notification) =>
            notification.read_at == null && !dismissedIds.has(notification.id),
        )
        .sort(
          (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
        ),
    [data, dismissedIds],
  );
  const visible = unread.slice(0, MAX_VISIBLE_NOTIFICATIONS);

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

  // A view preference, not a read: the notifications stay unread and come back as they were.
  function minimize(next: boolean) {
    setMinimized(next);
    setNotificationsMinimized(next);
  }

  function clearAll() {
    if (unread.length === 0 || readAllNotifications.isPending) return;
    readAllNotifications.mutate(undefined, {
      onError: (error) =>
        showError(
          error instanceof Error
            ? error.message
            : "Failed to clear notifications.",
        ),
    });
  }

  if (!isError && unread.length === 0) return null;

  return (
    <section
      aria-label="Unread notifications"
      aria-live="polite"
      data-debug-component="NotificationStack"
      className="pointer-events-none fixed right-4 bottom-12 z-40 flex max-h-[calc(100vh-4rem)] w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto"
    >
      {unread.length > 0 ? (
        // One button carries both states so toggling keeps it mounted, and a keyboard user who
        // folds the stack stays on the control that unfolds it again.
        <div className="pointer-events-auto flex justify-end gap-2">
          <button
            type="button"
            onClick={() => minimize(!minimized)}
            aria-expanded={!minimized}
            aria-label={minimized ? undefined : "Minimize notifications"}
            title={minimized ? "Show notifications" : "Minimize"}
            className={cn(
              "inline-flex items-center rounded-md border bg-background text-xs font-medium hover:bg-accent hover:text-accent-foreground",
              minimized
                ? "gap-1.5 px-2.5 py-1 text-foreground shadow-lg"
                : "px-2 py-1 text-muted-foreground shadow-sm",
            )}
          >
            {minimized ? (
              <>
                <Bell className="size-3.5" aria-hidden="true" />
                {unread.length} unread
              </>
            ) : (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            )}
          </button>
          {minimized ? null : (
            <button
              type="button"
              onClick={clearAll}
              disabled={readAllNotifications.isPending}
              className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear all
            </button>
          )}
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
      {minimized
        ? null
        : visible.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              onRead={() => markRead(notification)}
            />
          ))}
    </section>
  );
}

function NotificationItem({
  notification,
  onRead,
}: {
  notification: Notification;
  onRead: () => void;
}) {
  const Icon = notificationIcon(notification);
  const label = resourceLabel(notification);
  const costHeldRun = costHeldWorkflowRun(notification);
  const reworkHeldRun = reworkHeldWorkflowRun(notification);
  const resourceTitle = notification.resource.title ?? notification.title;
  const resourceHeading =
    notification.resource.number == null
      ? resourceTitle
      : `${resourceTitle} #${notification.resource.number}`;
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
        {/* A new tab, not an SPA navigation: reading a notification should not cost the supervisor
            the screen they were working on. The target stays the same in-app path. */}
        <a
          href={notification.resource.href}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${label} in a new tab`}
          onClick={onRead}
          className="block rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <div className="truncate text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {notificationKindLabel(notification)}
          </div>
          <div className="flex items-baseline gap-1.5">
            {/* The title stays shrinkable: one long enough to fill the row has to ellipsize
                rather than push the row wider. */}
            <span className="min-w-0 truncate font-semibold">
              {resourceHeading}
            </span>
            <ExternalLink
              className="size-3 shrink-0 self-center text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {notification.body}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{notification.repo.name}</span>
            <span aria-hidden="true">/</span>
            <span className="shrink-0">{label}</span>
            <time
              className="ml-auto shrink-0"
              dateTime={notification.created_at}
            >
              {relativeTime(notification.created_at)}
            </time>
          </div>
        </a>
        {costHeldRun != null && notification.resource.number != null ? (
          <WorkflowBudgetAction
            repo={notification.repo.name}
            pull={notification.resource.number}
            run={costHeldRun}
            onRead={onRead}
          />
        ) : null}
        {reworkHeldRun != null && notification.resource.number != null ? (
          <WorkflowReworkAction
            repo={notification.repo.name}
            pull={notification.resource.number}
            run={reworkHeldRun}
            onRead={onRead}
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
      </div>
    </article>
  );
}

function WorkflowReworkAction({
  repo,
  pull,
  run,
  onRead,
}: {
  repo: string;
  pull: number;
  run: number;
  onRead: () => void;
}) {
  const [owner, name] = repo.split("/");
  const { data: state } = useWorkflowRunForPull(owner, name, pull);
  const increase = useIncreaseWorkflowRunReworkLimit(owner, name, pull);
  const [error, setError] = useState<string | null>(null);
  const [increasedLimit, setIncreasedLimit] = useState<number | null>(null);

  if (increasedLimit !== null) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Rework limit increased to {increasedLimit}.
      </p>
    );
  }
  if (!state || state.id !== run || !state.rework_limit_increase_available) {
    return null;
  }
  const nextLimit = state.rework_limit * 2;
  return (
    <div className="mt-2 flex flex-col items-start gap-1 text-xs">
      <YesNoPrompt
        question={`Increase rework limit to ${nextLimit}?`}
        pending={increase.isPending}
        onYes={() =>
          increase.mutate(
            { run: state.id, expectedLimit: state.rework_limit },
            {
              onSuccess: (result) => {
                setError(null);
                setIncreasedLimit(result.current_limit);
              },
              onError: (failure) =>
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Failed to increase the workflow rework limit.",
                ),
            },
          )
        }
        onNo={onRead}
      />
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
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
  onRead,
}: {
  repo: string;
  pull: number;
  run: number;
  onRead: () => void;
}) {
  const [owner, name] = repo.split("/");
  const { data: state } = useWorkflowRunForPull(owner, name, pull);
  const increaseCostLimit = useIncreaseWorkflowRunCostLimit(owner, name, pull);
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
        onNo={onRead}
      />
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
