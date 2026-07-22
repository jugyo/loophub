import { createRoute, Link } from "@tanstack/react-router";
import { Archive, FolderPlus, X } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { RepoList } from "@/components/repo-list";
import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/lib/page-title";
import { useCreateRepo, useRepos } from "@/queries/repos";
import { rootRoute } from "./root";

export function HomePage() {
  usePageTitle(["Repositories"]);
  const repos = useRepos();
  const [adding, setAdding] = useState(false);

  return (
    <div
      data-debug-component="HomePage"
      className="mx-auto flex max-w-content flex-col gap-8"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Active repositories registered in LoopHub.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setAdding(true)}>
            <FolderPlus className="size-4" aria-hidden="true" />
            Add repository
          </Button>
        </div>
      </div>

      <RepoList
        query={repos}
        emptyTitle="No repositories yet"
        emptyDescription="Add a repository to start tracking issues and pull requests."
      />
      <div className="-mt-4 flex justify-end">
        <Link
          to="/archived"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Archive className="size-4" aria-hidden="true" />
          Archived repositories
        </Link>
      </div>
      {adding ? <AddRepositoryDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function AddRepositoryDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateRepo();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { path: path.trim(), name: name.trim() };
    if (!input.path || !input.name || create.isPending) return;
    try {
      await create.mutateAsync(input);
    } catch {
      return;
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        data-debug-component="AddRepositoryDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-repository-title"
        className="w-full max-w-md rounded-md border bg-card p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
        onSubmit={onSubmit}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="add-repository-title" className="text-base font-semibold">
              Add repository
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Register a local git repository with LoopHub.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="mt-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Local path
            <input
              type="text"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className="rounded-md border bg-background px-3 py-1.5 text-sm font-normal"
              placeholder="/path/to/repo"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Repository name
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="rounded-md border bg-background px-3 py-1.5 text-sm font-normal"
              placeholder="owner/name"
            />
          </label>
        </div>

        {create.error ? (
          <p className="mt-3 text-sm text-destructive">
            {String(create.error)}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={create.isPending || !path.trim() || !name.trim()}
          >
            {create.isPending ? "Adding..." : "Add repository"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
