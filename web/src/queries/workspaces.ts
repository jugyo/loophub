import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWorkspace,
  listArchivedWorkspaces,
  listWorkspaces,
  resolveWorkspace,
  setWorkspaceArchived,
} from "@/api/client";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

export function workspaceQueryOptions(owner: string, repo: string) {
  return {
    queryKey: queryKeys.workspaces(full(owner, repo)),
    queryFn: () => listWorkspaces(owner, repo),
  };
}

export function useWorkspaces(owner: string, repo: string) {
  return useQuery(workspaceQueryOptions(owner, repo));
}

export function useWorkspaceResolution(branch: string | null) {
  return useQuery({
    queryKey: ["workspaces", "resolve", branch],
    queryFn: () => resolveWorkspace(branch!),
    enabled: branch !== null,
    retry: false,
  });
}

export function useArchivedWorkspaces(owner: string, repo: string) {
  return useQuery({
    queryKey: [...queryKeys.workspaces(full(owner, repo)), "archived"],
    queryFn: () => listArchivedWorkspaces(owner, repo),
  });
}

export function useCreateWorkspace(owner: string, repo: string) {
  return useMutation({
    mutationFn: (branch: string) => createWorkspace(owner, repo, branch),
  });
}

export function useSetWorkspaceArchived(owner: string, repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ branch, archived }: { branch: string; archived: boolean }) =>
      setWorkspaceArchived(owner, repo, branch, archived),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["workspaces"],
      }),
  });
}
