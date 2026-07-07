import { createRoute } from "@tanstack/react-router";
import { ScheduledTasksPage } from "@/components/scheduled-tasks-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function RepoScheduledTasksRoutePage() {
  const { owner, repo } = repoScheduledTasksRoute.useParams();
  usePageTitle([`${owner}/${repo}`, "Scheduled tasks"]);
  return <ScheduledTasksPage owner={owner} repo={repo} />;
}

export const repoScheduledTasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/scheduled-tasks",
  component: RepoScheduledTasksRoutePage,
});
