// The terminal dock's tabs (#2574). terminal.agent_state_changed (lib/event-keys.ts) keeps them fresh.

import { useQuery } from "@tanstack/react-query";
import { getPullTerminals } from "@/api/client";
import { queryKeys } from "./keys";

export function usePullTerminals(owner: string, repo: string, number: number) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.pullTerminals(full, number),
    queryFn: () => getPullTerminals(full, number),
  });
}
