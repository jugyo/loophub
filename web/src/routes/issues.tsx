import { createRoute } from "@tanstack/react-router";
import { IssueDetail } from "@/components/issue-detail";
import { IssueList } from "@/components/issue-list";
import { rootRoute } from "./root";

function IssuesPage() {
  const { owner, repo } = issuesRoute.useParams();
  const { labels, state } = issuesRoute.useSearch();
  return (
    <IssueList
      owner={owner}
      repo={repo}
      labelsParam={labels}
      stateParam={state}
    />
  );
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
  // here pre-filtered (#368). `state` seeds the state filter so the repo
  // dashboard can deep-link to the closed issues list (#616). Both are omitted
  // from the URL at their default (blank labels / open state) to keep it clean.
  validateSearch: (
    search: Record<string, unknown>,
  ): { labels?: string; state?: "closed" | "all" } => {
    const labels =
      typeof search.labels === "string" ? search.labels.trim() : "";
    const state =
      search.state === "closed" || search.state === "all"
        ? search.state
        : undefined;
    return { ...(labels ? { labels } : {}), ...(state ? { state } : {}) };
  },
});

export const issueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/issues/$number",
  component: IssueDetailPage,
});
