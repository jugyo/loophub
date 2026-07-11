import { createRoute, Navigate } from "@tanstack/react-router";
import { ScheduledTasksPage } from "@/components/scheduled-tasks-page";
import { usePageTitle } from "@/lib/page-title";
import { useWebConfig } from "@/lib/web-config";
import { rootRoute } from "./root";

function RepoScheduledTasksRoutePage() {
  const { owner, repo } = repoScheduledTasksRoute.useParams();
  const { experimental } = useWebConfig();
  usePageTitle([`${owner}/${repo}`, "Scheduled tasks"]);
  if (!experimental) {
    return <Navigate to="/r/$owner/$repo" params={{ owner, repo }} />;
  }
  return <ScheduledTasksPage owner={owner} repo={repo} />;
}

export const repoScheduledTasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/scheduled-tasks",
  component: RepoScheduledTasksRoutePage,
});
