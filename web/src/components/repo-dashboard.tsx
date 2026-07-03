// Repo dashboard body (/r/:owner/:repo). Renders the "now" Open Issues section
// from DESIGN.md § Dashboard sections, capped at SECTION_LIMIT with a "see all"
// link to the dedicated list view. Each issue row carries its linked PR as a
// sub-row, so a separate PR list is redundant here. The list is TanStack Query
// backed and refetches on SSE (root.tsx + event-keys).

import { Link } from "@tanstack/react-router";
import { IssueRow } from "@/components/dashboard-rows";
import { DashboardSection } from "@/components/dashboard-section";
import { RepoSettingsLink } from "@/components/repo-settings-link";
import { useOpenIssues } from "@/queries/dashboard";

export function RepoDashboard({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const issues = useOpenIssues(owner, repo);

  return (
    <div className="mx-auto flex max-w-content flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {owner}/{repo}
          </h1>
        </div>
        <RepoSettingsLink owner={owner} repo={repo} />
      </div>

      <div className="flex flex-col gap-1">
        <DashboardSection
          title="Open Issues"
          query={issues}
          seeAllTo="/r/$owner/$repo/issues"
          seeAllParams={{ owner, repo }}
          emptyText="No open issues."
          keyOf={(i) => i.number}
          renderItem={(i) => <IssueRow owner={owner} repo={repo} issue={i} />}
        />
        <Link
          to="/r/$owner/$repo/issues"
          params={{ owner, repo }}
          search={{ state: "closed" }}
          className="self-end text-xs text-muted-foreground hover:text-foreground"
        >
          View closed issues
        </Link>
      </div>
    </div>
  );
}
