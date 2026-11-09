import { createRoute } from "@tanstack/react-router";
import { PullDetail } from "@/components/pull-detail";
import { PullTerminalDock } from "@/components/pull-terminal-dock";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function PullDetailPage() {
  const { owner, repo, number } = pullDetailRoute.useParams();
  usePageTitle([`${owner}/${repo}`, `PR #${number}`]);
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        {/* Which pane is open and how far the left column is scrolled belong to the PR being read. */}
        <PullDetail
          key={`${owner}/${repo}/${number}`}
          owner={owner}
          repo={repo}
          number={Number(number)}
        />
      </div>
      {/* The dock's own margins assume <main>'s padding, which this page turns off. */}
      <div className="px-4 sm:px-6 [&>*]:mt-0">
        <PullTerminalDock owner={owner} repo={repo} number={Number(number)} />
      </div>
    </div>
  );
}

export const pullDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/pulls/$number",
  component: PullDetailPage,
});
