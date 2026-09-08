// Rings the notification bell when a new unread notification arrives (#2508), so an unattended
// screen is noticed by ear instead of by an unread badge nobody is watching.

import { useEffect, useRef } from "react";
import {
  type NotificationSoundPlayback,
  recordNotificationSound,
} from "@/lib/debug-log";
import { notificationMatchesPath } from "@/lib/notification-resource";
import { playNotificationBell } from "@/lib/notification-sound";
import { usePageVisibility } from "@/lib/use-page-visibility";
import { useNotifications } from "@/queries/notifications";
import { useSettings } from "@/queries/settings";

// A worker sweep can create several notifications at once, each arriving as its own list refresh.
// One bell covers the burst instead of ringing over itself.
const BELL_COOLDOWN_MS = 2000;
const NOTIFICATION_SOUND_LOCK = "loophub-notification-sound";
const LAST_NOTIFICATION_SOUND_ID = "loophub-last-notification-sound-id";

interface NotificationSoundLockManager {
  request<T>(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: object | null) => Promise<T>,
  ): Promise<T>;
}

// この識別子は読み込まれたページのモジュール内だけに存在する。永続化せず、セッションを
// またいで追跡できない範囲で複数タブの debug ログを比較するために使う。
function createSoundInstanceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 10);
}

const SOUND_INSTANCE_ID = createSoundInstanceId();

function cooldownElapsedMs(
  lastPlayedAt: number | null,
  now: number,
): number | null {
  return lastPlayedAt == null ? null : Math.max(0, now - lastPlayedAt);
}

/** Play the bell only when this tab wins the browser-wide notification lock. */
export function playNotificationBellOnce(
  notificationId: number,
): Promise<NotificationSoundPlayback | null> {
  const locks = (
    globalThis.navigator as Navigator & { locks?: NotificationSoundLockManager }
  ).locks;
  if (!locks) return playNotificationBell();

  return locks.request(
    NOTIFICATION_SOUND_LOCK,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return null;

      let lastNotificationId: number | null = null;
      try {
        const stored = globalThis.localStorage.getItem(
          LAST_NOTIFICATION_SOUND_ID,
        );
        lastNotificationId = stored == null ? null : Number(stored);
      } catch {
        // The lock still prevents concurrent playback when storage is unavailable.
      }
      if (lastNotificationId === notificationId) return null;

      try {
        globalThis.localStorage.setItem(
          LAST_NOTIFICATION_SOUND_ID,
          String(notificationId),
        );
      } catch {
        // Continue with playback when storage is unavailable.
      }
      return playNotificationBell();
    },
  );
}

export function useNotificationSound(pathname: string): void {
  // Same input as NotificationStack's, so both read one cached list rather than fetching twice.
  const { data } = useNotifications({ unreadOnly: true });
  const settings = useSettings();
  const enabled = settings.data?.notificationSound ?? true;
  const pageVisible = usePageVisibility();
  // Highest notification id seen so far, null until the first list arrives — the unread
  // notifications already waiting at page load are seen, not announced.
  const lastSeenId = useRef<number | null>(null);
  const lastPlayedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!data) return;
    const previousId = lastSeenId.current;
    const newestId = data.reduce(
      (newest, notification) => Math.max(newest, notification.id),
      0,
    );
    lastSeenId.current = Math.max(previousId ?? 0, newestId);
    if (previousId == null) return;
    if (data.length === 0) return;

    const at = Date.now();
    const elapsed = cooldownElapsedMs(lastPlayedAt.current, at);
    // Reading a notification or refetching the same list never raises the newest id, so only an
    // actual arrival gets past here.
    if (newestId <= previousId) {
      recordNotificationSound({
        at,
        instanceId: SOUND_INSTANCE_ID,
        notificationId: newestId,
        decision: "duplicate",
        reason: "same_id",
        cooldownElapsedMs: elapsed,
        playback: null,
      });
      return;
    }
    if (!enabled) {
      recordNotificationSound({
        at,
        instanceId: SOUND_INSTANCE_ID,
        notificationId: newestId,
        decision: "disabled",
        reason: "new_id",
        cooldownElapsedMs: elapsed,
        playback: null,
      });
      return;
    }
    const arrivedWhileNotViewing = data.some(
      (notification) =>
        notification.id > previousId &&
        (!pageVisible || !notificationMatchesPath(notification, pathname)),
    );
    if (!arrivedWhileNotViewing) return;
    if (elapsed != null && elapsed < BELL_COOLDOWN_MS) {
      recordNotificationSound({
        at,
        instanceId: SOUND_INSTANCE_ID,
        notificationId: newestId,
        decision: "cooldown",
        reason: "new_id",
        cooldownElapsedMs: elapsed,
        playback: null,
      });
      return;
    }

    lastPlayedAt.current = at;
    void playNotificationBellOnce(newestId).then(
      (playback: NotificationSoundPlayback | null) => {
        if (playback == null) return;
        recordNotificationSound({
          at,
          instanceId: SOUND_INSTANCE_ID,
          notificationId: newestId,
          decision: "play",
          reason: "new_id",
          cooldownElapsedMs: elapsed,
          playback,
        });
      },
    );
  }, [data, enabled, pageVisible, pathname]);
}
