import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { RepoList } from "@/components/repo-list";
import { useRepos } from "@/queries/repos";

function HomePage() {
  const query = useRepos();
  return (
    <div className="mx-auto max-w-content">
      <h1 className="text-2xl font-semibold">Repositories</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Pick a repository to view its issues and pull requests.
      </p>
      <div className="mt-6">
        <RepoList
          query={query}
          emptyTitle="No repositories yet"
          emptyDescription="Register a repository with the LoopHub CLI to get started."
        />
      </div>
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
