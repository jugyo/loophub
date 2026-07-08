import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveInboxMessage,
  deleteInboxMessage,
  getInboxMessage,
  listInboxMessages,
  readInboxMessage,
  unarchiveInboxMessage,
  unreadInboxMessage,
} from "@/api/client";
import type { InboxMessage } from "@/api/types";
import { queryKeys } from "./keys";

export function useInboxMessages(
  input: { state?: InboxMessage["state"]; limit?: number } = {},
) {
  return useQuery({
    queryKey: [...queryKeys.inbox(), "list", input],
    queryFn: () => listInboxMessages(input),
  });
}

export function useInboxMessage(id: number) {
  return useQuery({
    queryKey: queryKeys.inboxMessage(id),
    queryFn: () => getInboxMessage(id),
  });
}

export function useInboxMessageAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: number;
      action: "read" | "unread" | "archive" | "unarchive" | "delete";
    }) => {
      if (action === "read") return readInboxMessage(id);
      if (action === "unread") return unreadInboxMessage(id);
      if (action === "archive") return archiveInboxMessage(id);
      if (action === "unarchive") return unarchiveInboxMessage(id);
      return deleteInboxMessage(id);
    },
    onSuccess: (message) => {
      qc.invalidateQueries({ queryKey: queryKeys.inbox() });
      qc.invalidateQueries({ queryKey: queryKeys.inboxMessage(message.id) });
    },
  });
}
