import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { RepoDashboard } from "@/components/repo-dashboard";

function RepoPage() {
  const { owner, repo } = repoRoute.useParams();
  return <RepoDashboard owner={owner} repo={repo} />;
}

export const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo",
  component: RepoPage,
});
