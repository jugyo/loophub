import { useMutation, useQuery } from "@tanstack/react-query";
import {
  focusHerdrAgent,
  getHerdrSessions,
  launchTerminalWorkflow,
  sendHerdrAgentInput,
} from "@/api/client";

export const terminalKeys = {
  sessions: ["terminal", "sessions"] as const,
};

export function useLaunchTerminalWorkflow() {
  return useMutation({
    mutationFn: launchTerminalWorkflow,
  });
}

/**
 * Running herdr sessions for UI surfaces that actually render terminal state. This polls while
 * mounted instead of depending on the old terminal event invalidation path; React Query shares the
 * single query across observers, so multiple components in one tab do not spawn parallel reads.
 * Errors are not retried; note react-query keeps the last successful `data` across a failed
 * refetch, so the component checks `isError` to hide the section rather than relying on `data`
 * becoming undefined.
 */
export function useHerdrSessions(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: terminalKeys.sessions,
    queryFn: getHerdrSessions,
    enabled: opts.enabled ?? true,
    refetchInterval: 3000,
    retry: false,
  });
}

/**
 * Focus mutation for the issue-list "Herdr running" badge (#579): switches herdr's focus to
 * the agent pane the issue's PR is running in (reuses #578's `herdr agent focus`). No sessions
 * invalidation needed — unlike the kill button, focusing doesn't change what terminal/sessions
 * reports.
 */
export function useFocusHerdrAgent() {
  return useMutation({
    mutationFn: focusHerdrAgent,
  });
}

/** Send one message after the server revalidates the agent's PR/worktree pane. */
export function useSendHerdrAgentInput() {
  return useMutation({ mutationFn: sendHerdrAgentInput });
}
