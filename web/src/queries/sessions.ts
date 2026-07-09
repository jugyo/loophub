import { useQuery } from "@tanstack/react-query";
import { getAgentCostSummary, getAgentSessions } from "@/api/client";
import { queryKeys } from "./keys";

export function useAgentSessions() {
  return useQuery({
    queryKey: queryKeys.agentSessions(),
    queryFn: getAgentSessions,
  });
}

export function useAgentCostSummary() {
  return useQuery({
    queryKey: [...queryKeys.agentSessions(), "cost-summary"],
    queryFn: getAgentCostSummary,
    refetchInterval: 60_000,
  });
}
