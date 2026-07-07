import { createRoute } from "@tanstack/react-router";
import { IssueList } from "@/components/issue-list";
import { usePageTitle } from "@/lib/page-title";
import { validateIssueListSearch } from "./repo";
import { rootRoute } from "./root";

function RepoIssuesPage() {
  const { owner, repo } = repoIssuesRoute.useParams();
  const { labels, state } = repoIssuesRoute.useSearch();
  usePageTitle([`${owner}/${repo}`, "Issues"]);
  return (
    <IssueList
      owner={owner}
      repo={repo}
      labelsParam={labels}
      stateParam={state}
    />
  );
}

export const repoIssuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/issues",
  component: RepoIssuesPage,
  validateSearch: validateIssueListSearch,
});
