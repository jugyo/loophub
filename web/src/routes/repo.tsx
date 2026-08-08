import { createRoute } from "@tanstack/react-router";
import { IssueList } from "@/components/issue-list";
import { RepoSidebar } from "@/components/repo-sidebar";
import { RepositorySearch } from "@/components/repository-search";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export function RepoPage() {
  const { owner, repo } = repoRoute.useParams();
  const { labels, state, workspace } = repoRoute.useSearch();
  usePageTitle([`${owner}/${repo}`, "Issues"]);
  return (
    // Two columns, like the PR detail (#346): the issue list on the left and the repo sidebar
    // (#71) on the right, from the top. Below `lg` the sidebar wraps under the list, and the page
    // only widens past `max-w-content` while the two actually sit side by side.
    <div
      data-debug-component="RepoPage"
      className="mx-auto max-w-content lg:max-w-content-wide"
    >
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-4">
          {/* Same `mx-auto max-w-content` cap as the IssueList below it, so the search row keeps
              lining up with the list once the column widens for the sidebar. */}
          <div className="mx-auto flex w-full max-w-content items-center justify-end gap-3">
            <RepositorySearch owner={owner} repo={repo} />
          </div>
          <IssueList
            owner={owner}
            repo={repo}
            labelsParam={labels}
            stateParam={state}
            workspaceParam={workspace}
            labelFilterMode="select"
            showWorkspaceFilter
          />
        </div>
        <RepoSidebar owner={owner} repo={repo} />
      </div>
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
  workspace?: string;
} {
  const labels = typeof search.labels === "string" ? search.labels.trim() : "";
  const workspace =
    typeof search.workspace === "string" ? search.workspace.trim() : "";
  const state =
    search.state === "closed" || search.state === "all"
      ? search.state
      : undefined;
  return {
    ...(labels ? { labels } : {}),
    ...(state ? { state } : {}),
    ...(workspace ? { workspace } : {}),
  };
}
