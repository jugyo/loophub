import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getHerdrSessions,
  getTerminalLaunchConfig,
  launchTerminalWorkflow,
} from "@/api/client";

export const terminalKeys = {
  config: ["terminal", "config"] as const,
  sessions: ["terminal", "sessions"] as const,
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
