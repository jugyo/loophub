import { useQuery } from "@tanstack/react-query";
import { getAgentSessions } from "@/api/client";
import { queryKeys } from "./keys";

export function useAgentSessions() {
  return useQuery({
    queryKey: queryKeys.agentSessions(),
    queryFn: getAgentSessions,
  });
}
