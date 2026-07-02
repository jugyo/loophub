import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "@/api/client";
import type { CodingAgent, TerminalLaunchBackend } from "@/api/types";

export const settingsKeys = {
  all: ["settings"] as const,
};

export function useSettings() {
  return useQuery({
    queryKey: settingsKeys.all,
    queryFn: getSettings,
  });
}

/**
 * Update instance-level settings, then refetch both the settings view and
 * `useTerminalLaunchConfig()` — the terminal pane / New Issue button read the backend from the
 * latter, not from this hook (#474).
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      terminalLaunchBackend?: TerminalLaunchBackend;
      autoModeOnBuild?: boolean;
      codingAgent?: CodingAgent;
    }) => updateSettings(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.all });
      qc.invalidateQueries({ queryKey: ["terminal", "config"] });
    },
  });
}
