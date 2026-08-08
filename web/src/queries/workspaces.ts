import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWorkspace,
  listArchivedSettingsWorkspaces,
  listArchivedWorkspaces,
  listSettingsWorkspaces,
  listWorkspaces,
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

export function useArchivedWorkspaces(owner: string, repo: string) {
  return useQuery({
    queryKey: [...queryKeys.workspaces(full(owner, repo)), "archived"],
    queryFn: () => listArchivedWorkspaces(owner, repo),
  });
}

export function useSettingsWorkspaces(owner: string, repo: string) {
  return useQuery({
    queryKey: [...queryKeys.workspaces(full(owner, repo)), "settings"],
    queryFn: () => listSettingsWorkspaces(owner, repo),
  });
}

export function useArchivedSettingsWorkspaces(owner: string, repo: string) {
  return useQuery({
    queryKey: [
      ...queryKeys.workspaces(full(owner, repo)),
      "settings",
      "archived",
    ],
    queryFn: () => listArchivedSettingsWorkspaces(owner, repo),
  });
}

export function useCreateWorkspace(owner: string, repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (branch: string) => createWorkspace(owner, repo, branch),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces(full(owner, repo)),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues(full(owner, repo)),
      });
    },
  });
}

export function useSetWorkspaceArchived(owner: string, repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ branch, archived }: { branch: string; archived: boolean }) =>
      setWorkspaceArchived(owner, repo, branch, archived),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces(full(owner, repo)),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues(full(owner, repo)),
      });
    },
  });
}
