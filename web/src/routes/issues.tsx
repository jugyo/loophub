import { createRoute } from "@tanstack/react-router";
import { IssueDetail } from "@/components/issue-detail";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function IssueDetailPage() {
  const { owner, repo, number } = issueDetailRoute.useParams();
  usePageTitle([`${owner}/${repo}`, `Issue #${number}`]);
  return <IssueDetail owner={owner} repo={repo} number={Number(number)} />;
}

export const issueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/issues/$number",
  component: IssueDetailPage,
});
