import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bell,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Loader2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Notification } from "@/api/types";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  useNotifications,
  useReadAllNotifications,
  useReadNotification,
  useUnreadNotificationCount,
} from "@/queries/notifications";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

const READ_GRACE_MS = 10_000;

function kindIcon(kind: Notification["kind"]) {
  if (kind === "implementation_done") return CheckCircle2;
  if (kind === "over_budget") return CircleDollarSign;
  return AlertTriangle;
}

function kindTone(kind: Notification["kind"]): string {
  if (kind === "implementation_done")
    return "text-emerald-700 dark:text-emerald-300";
  if (kind === "over_budget") return "text-amber-700 dark:text-amber-300";
  return "text-rose-700 dark:text-rose-300";
}

function resourceLabel(notification: Notification): string {
  const n = notification.resource.number;
  if (notification.resource.kind === "pull" && n != null) return `PR #${n}`;
  if (notification.resource.kind === "issue" && n != null) return `Issue #${n}`;
  return "Repository";
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useNotifications({ limit: 30 });
  const count = useUnreadNotificationCount();
  const readNotification = useReadNotification();
  const readAllNotifications = useReadAllNotifications();
  const focus = useFocusHerdrAgent();
  const herdrSessions = useHerdrSessions({ enabled: open });
  const { showError } = useToast();
  const [graceIds, setGraceIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (graceIds.size === 0) return;
    const timer = window.setTimeout(() => {
      setGraceIds(new Set());
    }, READ_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [graceIds]);

  const visible = useMemo(
    () =>
      (data ?? []).filter(
        (notification) =>
          notification.read_at == null || graceIds.has(notification.id),
      ),
    [data, graceIds],
  );
  const unread = count.data?.count ?? 0;
  const badge = unread > 99 ? "99+" : String(unread);

  function markRead(notification: Notification) {
    if (notification.read_at != null) return;
    setGraceIds((ids) => new Set(ids).add(notification.id));
    readNotification.mutate(notification.id, {
      onError: (e) =>
        showError(
          e instanceof Error ? e.message : "Failed to mark notification read.",
        ),
    });
  }

  function clearAll() {
    if (visible.length === 0 || readAllNotifications.isPending) return;
    setGraceIds(new Set());
    readAllNotifications.mutate(undefined, {
      onError: (e) =>
        showError(
          e instanceof Error ? e.message : "Failed to clear notifications.",
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

  function focusHerdr(notification: Notification, paneId: string | null) {
    if (!paneId) return;
    focus.mutate(
      { repo: notification.repo.name, paneId },
      {
        onError: (e) =>
          showError(
            e instanceof Error ? e.message : "Failed to open in Herdr.",
          ),
      },
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={
            unread > 0 ? `Notifications: ${unread} unread` : "Notifications"
          }
          title="Notifications"
          className="relative shrink-0"
        >
          <Bell className="size-4" aria-hidden="true" />
          {unread > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
              {badge}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[360px] p-0">
        <DropdownMenuLabel className="flex h-9 items-center justify-between gap-2 px-3">
          <span>Notifications</span>
          <span className="flex items-center gap-2">
            {isLoading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            <button
              type="button"
              onClick={clearAll}
              disabled={visible.length === 0 || readAllNotifications.isPending}
              className="text-xs font-normal text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
            >
              Clear all
            </button>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="m-0" />
        <div className="max-h-[420px] overflow-y-auto p-1">
          {isError ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              Failed to load notifications.
            </div>
          ) : visible.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              No notifications.
            </div>
          ) : (
            visible.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                read={notification.read_at != null}
                onRead={() => markRead(notification)}
                onNavigate={() => setOpen(false)}
                herdrPaneId={herdrPaneId(notification)}
                onFocusHerdr={(paneId) => focusHerdr(notification, paneId)}
                herdrPending={focus.isPending}
              />
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationItem({
  notification,
  read,
  onRead,
  onNavigate,
  onFocusHerdr,
  herdrPaneId,
  herdrPending,
}: {
  notification: Notification;
  read: boolean;
  onRead: () => void;
  onNavigate: () => void;
  onFocusHerdr: (paneId: string) => void;
  herdrPaneId: string | null;
  herdrPending: boolean;
}) {
  const Icon = kindIcon(notification.kind);
  return (
    <div
      className={cn(
        "group relative rounded-md transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground",
        read && "opacity-70",
      )}
    >
      <Link
        to={notification.resource.href}
        onClick={() => {
          onRead();
          onNavigate();
        }}
        className={cn(
          "flex min-h-20 gap-3 px-3 py-2.5 text-sm outline-none",
          herdrPaneId && "pr-12",
        )}
      >
        <Icon
          className={cn("mt-0.5 size-4 shrink-0", kindTone(notification.kind))}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">
              {notification.title}
            </span>
            {!read ? (
              <span
                className="mt-1 size-1.5 shrink-0 rounded-full bg-primary"
                aria-label="Unread"
              />
            ) : null}
          </span>
          <span className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-5 text-muted-foreground group-hover:text-accent-foreground">
            {notification.body}
          </span>
          <span className="mt-2 flex items-center gap-2 text-xs text-muted-foreground group-hover:text-accent-foreground">
            <span className="truncate">{notification.repo.name}</span>
            <span aria-hidden="true">/</span>
            <span>{resourceLabel(notification)}</span>
          </span>
        </span>
      </Link>
      {herdrPaneId ? (
        <button
          type="button"
          title="Open in Herdr"
          aria-label={`Open ${resourceLabel(notification)} in Herdr`}
          disabled={herdrPending}
          onClick={() => onFocusHerdr(herdrPaneId)}
          className="absolute bottom-2 right-3 inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-zinc-400 bg-zinc-500 text-zinc-50 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
        >
          <Bot className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
