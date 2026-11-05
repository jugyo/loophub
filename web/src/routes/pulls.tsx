import { createRoute } from "@tanstack/react-router";
import { PullDetail } from "@/components/pull-detail";
import { PullTerminalDock } from "@/components/pull-terminal-dock";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function PullDetailPage() {
  const { owner, repo, number } = pullDetailRoute.useParams();
  usePageTitle([`${owner}/${repo}`, `PR #${number}`]);
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <PullDetail owner={owner} repo={repo} number={Number(number)} />
      </div>
      <PullTerminalDock owner={owner} repo={repo} number={Number(number)} />
    </div>
  );
}

export const pullDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/pulls/$number",
  component: PullDetailPage,
});
