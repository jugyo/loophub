import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listNotifications,
  readAllNotifications,
  readNotification,
  unreadNotificationCount,
} from "@/api/client";
import type { Notification } from "@/api/types";
import { queryKeys } from "./keys";

function compareNotifications(a: Notification, b: Notification): number {
  const readOrder = Number(a.read_at != null) - Number(b.read_at != null);
  return readOrder || b.created_at.localeCompare(a.created_at) || b.id - a.id;
}

export function useNotifications(
  input: { limit?: number; unreadOnly?: boolean } = {},
) {
  return useQuery({
    queryKey: [...queryKeys.notifications(), "list", input],
    queryFn: () => listNotifications(input),
  });
}

// Keep list and unread count under one prefix: notification.created changes both, and
// notification.updated covers individual/read-all transitions that also change both views.
export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: [...queryKeys.notifications(), "unread-count"],
    queryFn: unreadNotificationCount,
  });
}

export function useReadNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => readNotification(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: queryKeys.notifications() });
      const listKey = [...queryKeys.notifications(), "list"];
      const countKey = [...queryKeys.notifications(), "unread-count"];
      const removed = qc
        .getQueriesData<Notification[]>({ queryKey: listKey })
        .flatMap(([key, current]) => {
          const notification = current?.find(
            ({ id: currentId }) => currentId === id,
          );
          return notification ? [{ key, notification }] : [];
        });
      const decrementedCount =
        removed.length > 0 && qc.getQueryData(countKey) != null;

      qc.setQueriesData<Notification[]>({ queryKey: listKey }, (current) =>
        current?.filter((notification) => notification.id !== id),
      );
      qc.setQueryData<{ count: number }>(countKey, (current) =>
        current && decrementedCount
          ? { count: Math.max(0, current.count - 1) }
          : current,
      );

      return { removed, decrementedCount, countKey };
    },
    onError: (_error, _id, context) => {
      const alreadyRestored = context?.removed.some(({ key, notification }) =>
        qc
          .getQueryData<Notification[]>(key)
          ?.some(({ id }) => id === notification.id),
      );
      let restored = false;
      for (const { key, notification } of context?.removed ?? []) {
        qc.setQueryData<Notification[]>(key, (current) => {
          if (!current || current.some(({ id }) => id === notification.id)) {
            return current;
          }
          restored = true;
          return [...current, notification].sort(compareNotifications);
        });
      }
      if (!alreadyRestored && restored && context?.decrementedCount) {
        qc.setQueryData<{ count: number }>(context.countKey, (current) =>
          current ? { count: current.count + 1 } : current,
        );
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.notifications() });
    },
  });
}

export function useReadAllNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => readAllNotifications(),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: queryKeys.notifications() });
      const listKey = [...queryKeys.notifications(), "list"];
      const countKey = [...queryKeys.notifications(), "unread-count"];
      const lists = qc.getQueriesData<Notification[]>({ queryKey: listKey });
      const count = qc.getQueryData<{ count: number }>(countKey);

      qc.setQueriesData<Notification[]>({ queryKey: listKey }, (current) =>
        current ? [] : current,
      );
      qc.setQueryData<{ count: number }>(countKey, (current) =>
        current ? { count: 0 } : current,
      );

      return { lists, count, countKey };
    },
    onError: (_error, _input, context) => {
      if (!context) return;
      for (const [key, notifications] of context.lists) {
        qc.setQueryData(key, notifications);
      }
      qc.setQueryData(context.countKey, context.count);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.notifications() });
    },
  });
}
