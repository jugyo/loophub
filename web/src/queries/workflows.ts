// workflow query hooks (#1006): the list query plus create / update / archive mutations for the
// Settings > Workflows page. Workflows are global (not repo-scoped), so a single list query key is
// used. Mutations invalidate that list onSuccess; event-polling invalidation (workflow.* in
// lib/event-keys.ts) keeps other tabs in sync. The same workflows/* RPCs back the CLI.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveWorkflow,
  createWorkflow,
  getWorkflowContracts,
  listWorkflows,
  updateWorkflow,
  type WorkflowInput,
} from "@/api/client";
import type { WorkflowContractLanguage } from "@/api/types";
import { queryKeys } from "./keys";

/** Global workflows, one repository's workflows, or workflows applicable to a repository. */
export function useWorkflows(
  input: { repo?: string; applicableToRepo?: string } = {},
) {
  return useQuery({
    queryKey: [
      ...queryKeys.workflows(),
      input.repo ?? "global",
      input.applicableToRepo,
    ],
    queryFn: () =>
      listWorkflows({
        repo: input.repo,
        applicable_to_repo: input.applicableToRepo,
      }),
  });
}

export function useWorkflowContracts(language?: WorkflowContractLanguage) {
  return useQuery({
    queryKey: ["workflows", "contracts", language],
    queryFn: getWorkflowContracts,
    staleTime: Infinity,
    enabled: language !== undefined,
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
      id: number;
      patch: Omit<Partial<WorkflowInput>, "name"> & { new_name?: string };
    }) => updateWorkflow(vars.id, vars.patch),
    onSuccess: () => invalidate(),
  });
}

export function useArchiveWorkflow() {
  const invalidate = useInvalidateWorkflows();
  return useMutation({
    mutationFn: (id: number) => archiveWorkflow(id),
    onSuccess: () => invalidate(),
  });
}
