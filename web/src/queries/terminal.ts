import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getHerdrAgentRead,
  getHerdrSessions,
  getTerminalLaunchConfig,
  launchTerminalWorkflow,
} from "@/api/client";

export const terminalKeys = {
  config: ["terminal", "config"] as const,
  sessions: ["terminal", "sessions"] as const,
  agentRead: (repo: string, target: string) =>
    ["terminal", "agentRead", repo, target] as const,
};

export function useTerminalLaunchConfig() {
  return useQuery({
    queryKey: terminalKeys.config,
    queryFn: getTerminalLaunchConfig,
  });
}

export function useLaunchTerminalWorkflow() {
  return useMutation({
    mutationFn: launchTerminalWorkflow,
  });
}

/**
 * Running herdr sessions for the sidebar section (#495). Light polling — the server
 * shells out to the herdr CLI on demand, so a modest interval keeps the status fresh
 * without hammering it. Errors are not retried; note react-query keeps the last
 * successful `data` across a failed refetch, so the component checks `isError` to
 * hide the section rather than relying on `data` becoming undefined.
 */
export function useHerdrSessions() {
  return useQuery({
    queryKey: terminalKeys.sessions,
    queryFn: getHerdrSessions,
    refetchInterval: 15_000,
    retry: false,
  });
}

/**
 * Recent terminal output for one herdr agent, for the sidebar hover preview (#500).
 * `enabled` gates the fetch on the caller's own hover debounce, so a quick pass over
 * a row never spawns a herdr process. `staleTime` then lets a second hover shortly
 * after reuse the cached preview instead of shelling out again — between the two,
 * hovering repeatedly can't flood herdr with reads.
 */
export function useHerdrAgentRead(
  repo: string,
  target: string,
  opts: { enabled: boolean },
) {
  return useQuery({
    queryKey: terminalKeys.agentRead(repo, target),
    queryFn: () => getHerdrAgentRead({ repo, target }),
    enabled: opts.enabled,
    staleTime: 15_000,
    retry: false,
  });
}
