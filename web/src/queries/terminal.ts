import { useMutation, useQuery } from "@tanstack/react-query";
import { getTerminalLaunchConfig, launchTerminalWorkflow } from "@/api/client";

export const terminalKeys = {
  config: ["terminal", "config"] as const,
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
