import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { PullList } from "@/components/pull-list";
import { PullDetail } from "@/components/pull-detail";

function PullsPage() {
  const { owner, repo } = pullsRoute.useParams();
  return <PullList owner={owner} repo={repo} />;
}

function PullDetailPage() {
  const { owner, repo, number } = pullDetailRoute.useParams();
  return <PullDetail owner={owner} repo={repo} number={Number(number)} />;
}

export const pullsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/pulls",
  component: PullsPage,
});

export const pullDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/pulls/$number",
  component: PullDetailPage,
});
