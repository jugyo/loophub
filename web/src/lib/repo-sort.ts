import type { Repo } from "@/api/types";

export function compareSidebarRepos(a: Repo, b: Repo): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
  return a.full_name.localeCompare(b.full_name, undefined, {
    sensitivity: "base",
  });
}
