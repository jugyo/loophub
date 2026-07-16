import { useMutation, useQuery } from "@tanstack/react-query";
import { createWorkspace, listWorkspaces } from "@/api/client";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

export function useWorkspaces(owner: string, repo: string) {
  return useQuery({
    queryKey: queryKeys.workspaces(full(owner, repo)),
    queryFn: () => listWorkspaces(owner, repo),
  });
}

export function useCreateWorkspace(owner: string, repo: string) {
  return useMutation({
    mutationFn: (branch: string) => createWorkspace(owner, repo, branch),
  });
}
