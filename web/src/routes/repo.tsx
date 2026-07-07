import { createRoute } from "@tanstack/react-router";
import { IssueList } from "@/components/issue-list";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function RepoPage() {
  const { owner, repo } = repoRoute.useParams();
  const { labels, state } = repoRoute.useSearch();
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

export const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo",
  component: RepoPage,
  // The repo top is the canonical issue list. Keep default open issues clean,
  // while allowing shared links to a label filter or the closed tab.
  validateSearch: validateIssueListSearch,
});

export function validateIssueListSearch(search: Record<string, unknown>): {
  labels?: string;
  state?: "closed" | "all";
} {
  const labels = typeof search.labels === "string" ? search.labels.trim() : "";
  const state =
    search.state === "closed" || search.state === "all"
      ? search.state
      : undefined;
  return { ...(labels ? { labels } : {}), ...(state ? { state } : {}) };
}
