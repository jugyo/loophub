import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listNotifications,
  readNotification,
  unreadNotificationCount,
} from "@/api/client";
import { queryKeys } from "./keys";

export function useNotifications(input: { limit?: number } = {}) {
  return useQuery({
    queryKey: [...queryKeys.notifications(), "list", input],
    queryFn: () => listNotifications(input),
  });
}

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.notifications() });
    },
  });
}
