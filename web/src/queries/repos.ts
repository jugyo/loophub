// Repo list query hooks. The app shell uses these for the sidebar; later UI
// issues add issue/pull hooks alongside in this directory.

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRepo, listRepos, setRepoArchived } from "@/api/client";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** Active (non-archived) repos for the sidebar. */
export function useRepos() {
  return useQuery({
    queryKey: queryKeys.repos(),
    queryFn: () => listRepos("false"),
  });
}

/** Archived repos for the /archived route. */
export function useArchivedRepos() {
  return useQuery({
    queryKey: [...queryKeys.repos(), "archived"],
    queryFn: () => listRepos("true"),
  });
}

/** Single repo (for archived state etc. on the detail screen). */
export function useRepo(owner: string, repo: string) {
  return useQuery({
    queryKey: queryKeys.repo(full(owner, repo)),
    queryFn: () => getRepo(owner, repo),
  });
}

/**
 * Archive / unarchive a repo, then invalidate the repo + the sidebar and
 * archived repo lists so the new state shows everywhere.
 */
export function useSetRepoArchived(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) => setRepoArchived(owner, repo, archived),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.repo(full(owner, repo)) });
      qc.invalidateQueries({ queryKey: queryKeys.repos() });
    },
  });
}
