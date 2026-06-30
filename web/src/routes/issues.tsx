import { createRoute } from "@tanstack/react-router";
import { IssueDetail } from "@/components/issue-detail";
import { IssueList } from "@/components/issue-list";
import { rootRoute } from "./root";

function IssuesPage() {
  const { owner, repo } = issuesRoute.useParams();
  const { labels } = issuesRoute.useSearch();
  return <IssueList owner={owner} repo={repo} labelsParam={labels} />;
}

function IssueDetailPage() {
  const { owner, repo, number } = issueDetailRoute.useParams();
  return <IssueDetail owner={owner} repo={repo} number={Number(number)} />;
}

export const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/issues",
  component: IssuesPage,
  // `labels` seeds the list's labels filter, so a label chip elsewhere can link
  // here pre-filtered (#368). Omitted/blank → no filter (kept out of the URL).
  validateSearch: (search: Record<string, unknown>): { labels?: string } => {
    const labels =
      typeof search.labels === "string" ? search.labels.trim() : "";
    return labels ? { labels } : {};
  },
});

export const issueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/issues/$number",
  component: IssueDetailPage,
});
