// Repo list with TanStack Query state handling, shared by the home (/) and
// archived (/archived) routes. Each row links to /r/:owner/:repo.

import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { Repo } from "@/api/types";

export function RepoList({
  query,
  emptyTitle,
  emptyDescription,
}: {
  query: UseQueryResult<Repo[]>;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const { data: repos, isLoading, isError, error } = query;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading repositories…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load repositories.
        {error instanceof Error ? ` ${error.message}` : null}
      </div>
    );
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center">
        <h2 className="text-base font-medium">{emptyTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {repos.map((repo) => {
        const [owner, name] = repo.full_name.split("/");
        return (
          <li key={repo.id}>
            <Link
              to="/r/$owner/$repo"
              params={{ owner, repo: name }}
              className="block rounded-md border px-4 py-3 hover:bg-accent hover:text-accent-foreground"
            >
              <span className="font-medium">{repo.full_name}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
