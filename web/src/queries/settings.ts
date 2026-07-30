import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSettings,
  type UpdateSettingsInput,
  updateSettings,
} from "@/api/client";

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
    mutationFn: (input: UpdateSettingsInput) => updateSettings(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.all });
    },
  });
}
