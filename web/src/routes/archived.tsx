import { createRoute } from "@tanstack/react-router";
import { RepoList } from "@/components/repo-list";
import { useArchivedRepos } from "@/queries/repos";
import { rootRoute } from "./root";

function ArchivedPage() {
  const query = useArchivedRepos();
  return (
    <div className="mx-auto max-w-content">
      <h1 className="text-2xl font-semibold">Archived</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Repositories that have been archived.
      </p>
      <div className="mt-6">
        <RepoList
          query={query}
          emptyTitle="No archived repositories"
          emptyDescription="Archived repositories appear here."
        />
      </div>
    </div>
  );
}

export const archivedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/archived",
  component: ArchivedPage,
});
