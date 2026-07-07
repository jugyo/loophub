// Scheduled task query hooks (#880): list / detail (with run log) queries and the
// create / update / delete / run-now mutations. Mutations invalidate the repo's task list
// (and the specific task's detail) so the UI reflects the change immediately; SSE-driven
// invalidation (scheduled_task.* in lib/event-keys.ts) keeps other tabs in sync.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  runScheduledTask,
  type ScheduledTaskInput,
  updateScheduledTask,
} from "@/api/client";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** A repo's scheduled tasks. */
export function useScheduledTasks(owner: string, repo: string) {
  return useQuery({
    queryKey: queryKeys.scheduledTasks(full(owner, repo)),
    queryFn: () => listScheduledTasks(owner, repo),
  });
}

/** One scheduled task with its recent run log. */
export function useScheduledTask(owner: string, repo: string, id: number) {
  return useQuery({
    queryKey: queryKeys.scheduledTask(full(owner, repo), id),
    queryFn: () => getScheduledTask(owner, repo, id),
  });
}

function useInvalidateTasks(owner: string, repo: string) {
  const qc = useQueryClient();
  return (id?: number) => {
    qc.invalidateQueries({
      queryKey: queryKeys.scheduledTasks(full(owner, repo)),
    });
    if (typeof id === "number")
      qc.invalidateQueries({
        queryKey: queryKeys.scheduledTask(full(owner, repo), id),
      });
  };
}

export function useCreateScheduledTask(owner: string, repo: string) {
  const invalidate = useInvalidateTasks(owner, repo);
  return useMutation({
    mutationFn: (input: ScheduledTaskInput) =>
      createScheduledTask(owner, repo, input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateScheduledTask(owner: string, repo: string) {
  const invalidate = useInvalidateTasks(owner, repo);
  return useMutation({
    mutationFn: (vars: { id: number; patch: Partial<ScheduledTaskInput> }) =>
      updateScheduledTask(owner, repo, vars.id, vars.patch),
    onSuccess: (_data, vars) => invalidate(vars.id),
  });
}

export function useDeleteScheduledTask(owner: string, repo: string) {
  const invalidate = useInvalidateTasks(owner, repo);
  return useMutation({
    mutationFn: (id: number) => deleteScheduledTask(owner, repo, id),
    onSuccess: () => invalidate(),
  });
}

/** Run now: fire immediately; invalidate the task detail so its run log refreshes. */
export function useRunScheduledTask(owner: string, repo: string) {
  const invalidate = useInvalidateTasks(owner, repo);
  return useMutation({
    mutationFn: (id: number) => runScheduledTask(owner, repo, id),
    onSuccess: (_data, id) => invalidate(id),
  });
}
