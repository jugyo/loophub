import { createRoute } from "@tanstack/react-router";
import { IssueList } from "@/components/issue-list";
import { RepositorySearch } from "@/components/repository-search";
import { WorkspacePicker } from "@/components/workspace-picker";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export function RepoPage() {
  const { owner, repo } = repoRoute.useParams();
  const { labels, state } = repoRoute.useSearch();
  usePageTitle([`${owner}/${repo}`, "Issues"]);
  return (
    <div className="space-y-4">
      <div className="mx-auto flex max-w-content items-center justify-between gap-3">
        <WorkspacePicker owner={owner} repo={repo} />
        <RepositorySearch owner={owner} repo={repo} />
      </div>
      <IssueList
        owner={owner}
        repo={repo}
        labelsParam={labels}
        stateParam={state}
        labelFilterMode="select"
      />
    </div>
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
