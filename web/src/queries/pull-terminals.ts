// The terminal dock's tabs (#2574). terminal.agent_state_changed (lib/event-keys.ts) keeps them fresh.

import { useMutation, useQuery } from "@tanstack/react-query";
import {
  closeIssueTerminal,
  closePullShell,
  getIssueTerminalHistory,
  getIssueTerminals,
  getPullTerminals,
  openPullShell,
  restoreIssueTerminal,
  restorePullTerminal,
} from "@/api/client";
import { queryKeys } from "./keys";

export function usePullTerminals(owner: string, repo: string, number: number) {
  const full = `${owner}/${repo}`;
  return useQuery({
    queryKey: queryKeys.pullTerminals(full, number),
    queryFn: () => getPullTerminals(full, number),
  });
}

export function useIssueTerminals(
  full: string,
  issue?: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.issueTerminals(full, issue),
    queryFn: () => getIssueTerminals(full, issue),
    enabled,
  });
}

// Mounted only while the dock shows its History tab.
export function useIssueTerminalHistory(full: string) {
  return useQuery({
    queryKey: queryKeys.issueTerminalHistory(full),
    queryFn: () => getIssueTerminalHistory(full),
  });
}

export function useCloseIssueTerminal() {
  return useMutation({ mutationFn: closeIssueTerminal });
}

export function useRestoreIssueTerminal() {
  return useMutation({ mutationFn: restoreIssueTerminal });
}

export function useRestorePullTerminal() {
  return useMutation({ mutationFn: restorePullTerminal });
}

export function useOpenPullShell() {
  return useMutation({ mutationFn: openPullShell });
}

export function useClosePullShell() {
  return useMutation({ mutationFn: closePullShell });
}
