import { createRoute } from "@tanstack/react-router";
import { PullDetail } from "@/components/pull-detail";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function PullDetailPage() {
  const { owner, repo, number } = pullDetailRoute.useParams();
  usePageTitle([`${owner}/${repo}`, `PR #${number}`]);
  return <PullDetail owner={owner} repo={repo} number={Number(number)} />;
}

export const pullDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/pulls/$number",
  component: PullDetailPage,
});
