import { useQuery } from "@tanstack/react-query";
import { listWorkspaces } from "@/api/client";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

export function useWorkspaces(owner: string, repo: string) {
  return useQuery({
    queryKey: queryKeys.workspaces(full(owner, repo)),
    queryFn: () => listWorkspaces(owner, repo),
  });
}
