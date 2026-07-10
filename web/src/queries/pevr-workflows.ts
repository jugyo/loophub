// PEVR workflow query hooks (#1006): the list query plus create / update / delete mutations for the
// Settings > Workflows page. Workflows are global (not repo-scoped), so a single list query key is
// used. Mutations invalidate that list onSuccess; SSE-driven invalidation (pevr_workflow.* in
// lib/event-keys.ts) keeps other tabs in sync. The same pevrWorkflows/* RPCs back the CLI.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPevrWorkflow,
  deletePevrWorkflow,
  listPevrWorkflows,
  type PevrWorkflowInput,
  updatePevrWorkflow,
} from "@/api/client";
import { queryKeys } from "./keys";

/** All PEVR workflows. */
export function usePevrWorkflows() {
  return useQuery({
    queryKey: queryKeys.pevrWorkflows(),
    queryFn: listPevrWorkflows,
  });
}

function useInvalidateWorkflows() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.pevrWorkflows() });
}

export function useCreatePevrWorkflow() {
  const invalidate = useInvalidateWorkflows();
  return useMutation({
    mutationFn: (input: PevrWorkflowInput) => createPevrWorkflow(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdatePevrWorkflow() {
  const invalidate = useInvalidateWorkflows();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      patch: Omit<Partial<PevrWorkflowInput>, "name"> & { new_name?: string };
    }) => updatePevrWorkflow(vars.name, vars.patch),
    onSuccess: () => invalidate(),
  });
}

export function useDeletePevrWorkflow() {
  const invalidate = useInvalidateWorkflows();
  return useMutation({
    mutationFn: (name: string) => deletePevrWorkflow(name),
    onSuccess: () => invalidate(),
  });
}
