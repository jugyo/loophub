import { AlertTriangle, Bell, X } from "lucide-react";
import { useToast } from "@/components/toast";
import { relativeTime } from "@/lib/time";
import { useNotifications, useReadNotification } from "@/queries/notifications";

const STACK_ITEM_CLASSES =
  "pointer-events-auto flex items-start gap-3 rounded-md border bg-background p-3 text-sm text-foreground shadow-lg";

export function NotificationStack() {
  const { data, isError } = useNotifications({ unreadOnly: true });
  const readNotification = useReadNotification();
  const { showError } = useToast();
  const unread = (data ?? []).filter(
    (notification) => notification.read_at == null,
  );

  if (!isError && unread.length === 0) return null;

  return (
    <section
      aria-label="Unread notifications"
      aria-live="polite"
      data-debug-component="NotificationStack"
      className="pointer-events-none fixed right-4 bottom-12 z-40 flex max-h-[calc(100vh-4rem)] w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto"
    >
      {isError ? (
        <div
          role="alert"
          className={`${STACK_ITEM_CLASSES} border-destructive/50 text-destructive`}
        >
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span>Failed to load notifications.</span>
        </div>
      ) : null}
      {unread.map((notification) => (
        <article key={notification.id} className={STACK_ITEM_CLASSES}>
          <Bell
            className="mt-0.5 size-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{notification.title}</div>
            <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">
              {notification.body}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">{notification.repo.name}</span>
              <time
                className="ml-auto shrink-0"
                dateTime={notification.created_at}
              >
                {relativeTime(notification.created_at)}
              </time>
            </div>
          </div>
          <button
            type="button"
            aria-label={`Close ${notification.title}`}
            title="Mark as read"
            onClick={() =>
              readNotification.mutate(notification.id, {
                onError: (error) =>
                  showError(
                    error instanceof Error
                      ? error.message
                      : "Failed to mark notification read.",
                  ),
              })
            }
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-70 hover:bg-accent hover:text-accent-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </article>
      ))}
    </section>
  );
}
