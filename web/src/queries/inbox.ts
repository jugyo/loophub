import { useQuery } from "@tanstack/react-query";
import { getInboxMessage, listInboxMessages } from "@/api/client";
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
