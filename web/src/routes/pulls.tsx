import { createRoute } from "@tanstack/react-router";
import { PullDetail } from "@/components/pull-detail";
import { PullList } from "@/components/pull-list";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function PullsPage() {
  const { owner, repo } = pullsRoute.useParams();
  usePageTitle([`${owner}/${repo}`, "Pull requests"]);
  return <PullList owner={owner} repo={repo} />;
}

function PullDetailPage() {
  const { owner, repo, number } = pullDetailRoute.useParams();
  usePageTitle([`${owner}/${repo}`, `PR #${number}`]);
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
