// Repo list query hooks. The app shell uses these for the sidebar; later UI
// issues add issue/pull hooks alongside in this directory.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getRepo,
  getRepoMergeMode,
  listRepos,
  setRepoArchived,
  setRepoFavorite,
  setRepoMergeMode,
} from "@/api/client";
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

/**
 * Favorite / unfavorite a repo, then invalidate the repo + the sidebar and
 * archived repo lists so the new state (and sort order) shows everywhere.
 */
export function useSetRepoFavorite(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (favorite: boolean) => setRepoFavorite(owner, repo, favorite),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.repo(full(owner, repo)) });
      qc.invalidateQueries({ queryKey: queryKeys.repos() });
    },
  });
}

/** Resolved merge-mode view for the repo settings toggle (#406). */
export function useRepoMergeMode(owner: string, repo: string) {
  return useQuery({
    queryKey: [...queryKeys.repo(full(owner, repo)), "merge-mode"],
    queryFn: () => getRepoMergeMode(owner, repo),
  });
}

/**
 * Set the repo's merge mode, then invalidate the resolved view, the repo, and any open PR detail or
 * list (both carry the effective mode from pullJSON). PR keys aren't enumerable here, so invalidate
 * the whole "pull" (detail) and "pulls" (list) key spaces — note the two are distinct strings, so a
 * single prefix won't cover both.
 */
export function useSetRepoMergeMode(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: "merge" | "github_pr" | "auto") =>
      setRepoMergeMode(owner, repo, mode),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: [...queryKeys.repo(full(owner, repo)), "merge-mode"],
      });
      qc.invalidateQueries({ queryKey: queryKeys.repo(full(owner, repo)) });
      qc.invalidateQueries({ queryKey: ["pull"] });
      qc.invalidateQueries({ queryKey: queryKeys.pulls(full(owner, repo)) });
    },
  });
}
