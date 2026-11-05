import { createRoute } from "@tanstack/react-router";
import { IssueDetail } from "@/components/issue-detail";
import { IssueTerminalDock } from "@/components/issue-terminal-dock";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function IssueDetailPage() {
  const { owner, repo, number } = issueDetailRoute.useParams();
  usePageTitle([`${owner}/${repo}`, `Issue #${number}`]);
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <IssueDetail owner={owner} repo={repo} number={Number(number)} />
      </div>
      <IssueTerminalDock owner={owner} repo={repo} />
    </div>
  );
}

export const issueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/issues/$number",
  component: IssueDetailPage,
});
