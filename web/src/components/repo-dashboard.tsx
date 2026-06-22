// Repo dashboard body (/r/:owner/:repo). Renders the "now" sections from
// DESIGN.md — Open PRs, Open Issues — each capped at SECTION_LIMIT with a
// "see all" link to the dedicated list view. Lists are TanStack Query backed
// and refetch on SSE (root.tsx + event-keys).

import { DashboardSection } from "@/components/dashboard-section";
import { IssueRow, PullRow } from "@/components/dashboard-rows";
import { CreateIssueButton } from "@/components/create-issue-button";
import { RepoMenu } from "@/components/repo-menu";
import { useOpenIssues, useOpenPulls } from "@/queries/dashboard";

export function RepoDashboard({ owner, repo }: { owner: string; repo: string }) {
  const issues = useOpenIssues(owner, repo);
  const pulls = useOpenPulls(owner, repo);

  return (
    <div className="mx-auto flex max-w-content flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {owner}/{repo}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What is happening in this project right now.
          </p>
        </div>
        <RepoMenu owner={owner} repo={repo} />
      </div>

      <DashboardSection
        title="Open PRs"
        query={pulls}
        seeAllTo="/r/$owner/$repo/pulls"
        seeAllParams={{ owner, repo }}
        emptyText="No open pull requests."
        keyOf={(p) => p.number}
        renderItem={(p) => <PullRow owner={owner} repo={repo} pull={p} />}
      />

      <DashboardSection
        title="Open Issues"
        query={issues}
        seeAllTo="/r/$owner/$repo/issues"
        seeAllParams={{ owner, repo }}
        emptyText="No open issues."
        keyOf={(i) => i.number}
        renderItem={(i) => <IssueRow owner={owner} repo={repo} issue={i} />}
        headerAction={<CreateIssueButton />}
      />
    </div>
  );
}
