// workflow query hooks (#1006): the list query plus create / update / delete mutations for the
// Settings > Workflows page. Workflows are global (not repo-scoped), so a single list query key is
// used. Mutations invalidate that list onSuccess; SSE-driven invalidation (workflow.* in
// lib/event-keys.ts) keeps other tabs in sync. The same workflows/* RPCs back the CLI.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowInput,
} from "@/api/client";
import { queryKeys } from "./keys";

/** All workflows. */
export function useWorkflows() {
  return useQuery({
    queryKey: queryKeys.workflows(),
    queryFn: listWorkflows,
  });
}

function useInvalidateWorkflows() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.workflows() });
}

export function useCreateWorkflow() {
  const invalidate = useInvalidateWorkflows();
  return useMutation({
    mutationFn: (input: WorkflowInput) => createWorkflow(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateWorkflow() {
  const invalidate = useInvalidateWorkflows();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      patch: Omit<Partial<WorkflowInput>, "name"> & { new_name?: string };
    }) => updateWorkflow(vars.name, vars.patch),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteWorkflow() {
  const invalidate = useInvalidateWorkflows();
  return useMutation({
    mutationFn: (name: string) => deleteWorkflow(name),
    onSuccess: () => invalidate(),
  });
}
