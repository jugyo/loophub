import type { Repo } from "@/api/types";
import { compareRepos } from "../../../core/repo-sort.ts";

export function compareSidebarRepos(a: Repo, b: Repo): number {
  return compareRepos(a, b);
}
