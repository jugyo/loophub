import { createRoute } from "@tanstack/react-router";
import { RepoDashboard } from "@/components/repo-dashboard";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function RepoPage() {
  const { owner, repo } = repoRoute.useParams();
  usePageTitle([`${owner}/${repo}`, "Repository"]);
  return <RepoDashboard owner={owner} repo={repo} />;
}

export const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo",
  component: RepoPage,
});
