// Repo list query hooks. The app shell uses these for the topbar; later UI
// issues add issue/pull hooks alongside in this directory.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRepo,
  getRepo,
  getRepoAgentConfig,
  getRepoMergeMode,
  listRepos,
  renameRepo,
  setRepoAgentConfig,
  setRepoArchived,
  setRepoDefaultBranch,
  setRepoFavorite,
  setRepoMergeMode,
} from "@/api/client";
import type { CodingAgent } from "@/api/types";
import { queryKeys } from "./keys";

const full = (owner: string, repo: string) => `${owner}/${repo}`;

/** Active (non-archived) repos for app-shell repository navigation. */
export function useRepos() {
  return useQuery({
    queryKey: queryKeys.repos(),
    queryFn: () => listRepos("false"),
  });
}

/**
 * Archived repos for the /archived route. This intentionally remains under the repos prefix:
 * repo archive/unarchive changes membership, while favorite and rename change row data or order,
 * so the archived and active lists share the same repo.* invalidation set.
 */
export function useArchivedRepos() {
  return useQuery({
    queryKey: [...queryKeys.repos(), "archived"],
    queryFn: () => listRepos("true"),
  });
}

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; name: string }) =>
      createRepo(input.path, input.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.repos() });
    },
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
 * Archive / unarchive a repo, then invalidate the repo + the topbar and
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
 * Favorite / unfavorite a repo, then invalidate the repo + the topbar and
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

/**
 * Rename the repo's owner/name (#485). Invalidates the topbar repo list; the caller
 * navigates to the new /r/:owner/:repo URL, whose queries fetch fresh under the
 * new name (the old repo's cached entries just go stale and unused).
 */
export function useRenameRepo(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (newName: string) => renameRepo(owner, repo, newName),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.repos() });
    },
  });
}

/**
 * Change the repo's base branch (default_branch) (#1115). Invalidates the repo so
 * everything reading it re-fetches — including the issue list, whose branch grouping
 * is computed from `default_branch`. Also invalidates the topbar repo list, which
 * carries the field.
 */
export function useSetRepoDefaultBranch(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (defaultBranch: string) =>
      setRepoDefaultBranch(owner, repo, defaultBranch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.repo(full(owner, repo)) });
      qc.invalidateQueries({ queryKey: queryKeys.repos() });
      qc.invalidateQueries({ queryKey: queryKeys.issues(full(owner, repo)) });
    },
  });
}

/** Resolved merge-mode view for the repo settings toggle (#406). */
export function useRepoMergeMode(owner: string, repo: string) {
  return useQuery({
    queryKey: queryKeys.repoMergeMode(full(owner, repo)),
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
        queryKey: queryKeys.repoMergeMode(full(owner, repo)),
      });
      qc.invalidateQueries({ queryKey: queryKeys.repo(full(owner, repo)) });
      qc.invalidateQueries({ queryKey: ["pull"] });
      qc.invalidateQueries({ queryKey: queryKeys.pulls(full(owner, repo)) });
    },
  });
}

/** Resolved Coding agent override view for the repo settings toggle (#1532). */
export function useRepoAgentConfig(
  owner: string,
  repo: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.repoAgentConfig(full(owner, repo)),
    queryFn: () => getRepoAgentConfig(owner, repo),
    enabled: enabled && Boolean(owner && repo),
  });
}

/**
 * Set the repo's Coding agent override, then invalidate the resolved view. Only workflow starts read
 * the effective config (at launch), so no PR/issue query carries it — the resolved view is the only
 * thing to refresh.
 */
export function useSetRepoAgentConfig(owner: string, repo: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      override: boolean;
      runtime?: CodingAgent | null;
      model?: string | null;
      effort?: string | null;
    }) => setRepoAgentConfig(owner, repo, input),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.repoAgentConfig(full(owner, repo)),
      });
    },
  });
}
