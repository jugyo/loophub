import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "@/api/client";
import type { CodingAgent, WorkflowContractLanguage } from "@/api/types";

export const settingsKeys = {
  all: ["settings"] as const,
};

export function useSettings() {
  return useQuery({
    queryKey: settingsKeys.all,
    queryFn: getSettings,
  });
}

/** Update instance-level settings, then refetch the settings view (#474). */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      agent?: CodingAgent;
      model?: string;
      effort?: string;
      codingAgent?: CodingAgent;
      devCostLimitUsd?: number;
      workflowContractLanguage?: WorkflowContractLanguage;
    }) => updateSettings(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}
