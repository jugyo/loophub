import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { IssueList } from "@/components/issue-list";
import { IssueDetail } from "@/components/issue-detail";

function IssuesPage() {
  const { owner, repo } = issuesRoute.useParams();
  return <IssueList owner={owner} repo={repo} />;
}

function IssueDetailPage() {
  const { owner, repo, number } = issueDetailRoute.useParams();
  return <IssueDetail owner={owner} repo={repo} number={Number(number)} />;
}

export const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/issues",
  component: IssuesPage,
});

export const issueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/issues/$number",
  component: IssueDetailPage,
});
