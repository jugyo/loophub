// Rings the notification bell when a new unread notification arrives (#2508), so an unattended
// screen is noticed by ear instead of by an unread badge nobody is watching.

import { useEffect, useRef } from "react";
import { notificationMatchesPath } from "@/lib/notification-resource";
import { playNotificationBell } from "@/lib/notification-sound";
import { usePageVisibility } from "@/lib/use-page-visibility";
import { useNotifications } from "@/queries/notifications";
import { useSettings } from "@/queries/settings";

// A worker sweep can create several notifications at once, each arriving as its own list refresh.
// One bell covers the burst instead of ringing over itself.
const BELL_COOLDOWN_MS = 2000;

export function useNotificationSound(pathname: string): void {
  // Same input as NotificationStack's, so both read one cached list rather than fetching twice.
  const { data } = useNotifications({ unreadOnly: true });
  const settings = useSettings();
  const enabled = settings.data?.notificationSound ?? true;
  const pageVisible = usePageVisibility();
  // Highest notification id seen so far, null until the first list arrives — the unread
  // notifications already waiting at page load are seen, not announced.
  const lastSeenId = useRef<number | null>(null);
  const lastPlayedAt = useRef(0);

  useEffect(() => {
    if (!data) return;
    const previousId = lastSeenId.current;
    const newestId = data.reduce(
      (newest, notification) => Math.max(newest, notification.id),
      0,
    );
    lastSeenId.current = Math.max(previousId ?? 0, newestId);
    // Reading a notification or refetching the same list never raises the newest id, so only an
    // actual arrival gets past here.
    if (previousId == null || newestId <= previousId || !enabled) return;
    const arrivedWhileNotViewing = data.some(
      (notification) =>
        notification.id > previousId &&
        (!pageVisible || !notificationMatchesPath(notification, pathname)),
    );
    if (!arrivedWhileNotViewing) return;
    const now = Date.now();
    if (now - lastPlayedAt.current < BELL_COOLDOWN_MS) return;
    lastPlayedAt.current = now;
    playNotificationBell();
  }, [data, enabled, pageVisible, pathname]);
}
