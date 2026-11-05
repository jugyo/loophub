// The terminal dock's tabs (#2574). terminal.agent_state_changed (lib/event-keys.ts) keeps them fresh.

import { useQuery } from "@tanstack/react-query";
import { getIssueTerminals, getPullTerminals } from "@/api/client";
import { queryKeys } from "./keys";

export function usePullTerminals(owner: string, repo: string, number: number) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.pullTerminals(full, number),
    queryFn: () => getPullTerminals(full, number),
  });
}

export function useIssueTerminals(full: string) {
  return useQuery({
    queryKey: queryKeys.issueTerminals(full),
    queryFn: () => getIssueTerminals(full),
  });
}
