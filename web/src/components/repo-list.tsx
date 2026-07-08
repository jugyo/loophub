// Repo list with TanStack Query state handling, shared by the home (/) and
// archived (/archived) routes. Each row links to /r/:owner/:repo.

import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2, Star } from "lucide-react";
import type { Repo } from "@/api/types";
import { useSetRepoFavorite } from "@/queries/repos";

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

  // Favorites first, then by the owner/repository display string,
  // case-insensitively, so app-shell repo order is stable regardless of the
  // API's return order.
  const sorted = [...repos].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return a.full_name.localeCompare(b.full_name, undefined, {
      sensitivity: "base",
    });
  });

  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((repo) => (
        <RepoListRow key={repo.id} repo={repo} />
      ))}
    </ul>
  );
}

function RepoListRow({ repo }: { repo: Repo }) {
  const [owner, name] = repo.full_name.split("/");
  const setFavorite = useSetRepoFavorite(owner, name);

  return (
    <li className="flex items-center gap-1 rounded-md border pr-2 hover:bg-accent hover:text-accent-foreground">
      <Link
        to="/r/$owner/$repo"
        params={{ owner, repo: name }}
        className="block flex-1 px-4 py-3"
      >
        <span className="font-medium">{repo.full_name}</span>
      </Link>
      <button
        type="button"
        aria-label={
          repo.favorite ? "Remove from favorites" : "Add to favorites"
        }
        aria-pressed={repo.favorite}
        disabled={setFavorite.isPending}
        onClick={() => setFavorite.mutate(!repo.favorite)}
        className="rounded-sm p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <Star
          className={`size-4 ${repo.favorite ? "fill-current text-yellow-600/70 dark:text-yellow-300/70" : ""}`}
        />
      </button>
    </li>
  );
}
