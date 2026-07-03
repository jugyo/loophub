import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  focusHerdrAgent,
  getHerdrAgentRead,
  getHerdrSessions,
  killHerdrAgent,
  launchTerminalWorkflow,
} from "@/api/client";

export const terminalKeys = {
  sessions: ["terminal", "sessions"] as const,
  agentRead: (repo: string, target: string) =>
    ["terminal", "agentRead", repo, target] as const,
};

export function useLaunchTerminalWorkflow() {
  return useMutation({
    mutationFn: launchTerminalWorkflow,
  });
}

/**
 * Running herdr sessions for the sidebar section (#495). A server-side watcher polls herdr
 * on lh-web's behalf and pushes an SSE `terminal` invalidation when the session/agent list
 * changes (#591) — see useLoopHubEvents — so this hook no longer polls on its own; refetch is
 * invalidate-driven, same as pulls/issues. Errors are not retried; note react-query keeps the
 * last successful `data` across a failed refetch, so the component checks `isError` to hide
 * the section rather than relying on `data` becoming undefined.
 */
export function useHerdrSessions() {
  return useQuery({
    queryKey: terminalKeys.sessions,
    queryFn: getHerdrSessions,
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

/**
 * Kill button mutation (#521): closes the pane a herdr agent is running in. Invalidates the
 * sessions list on success so the closed agent drops out of the sidebar without waiting for
 * the server-side herdr watcher's next terminal SSE invalidation (#591).
 */
export function useKillHerdrAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: killHerdrAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: terminalKeys.sessions });
    },
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
