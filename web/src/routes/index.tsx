import { createRoute } from "@tanstack/react-router";
import { IssueRow, PullRow } from "@/components/dashboard-rows";
import { DashboardSection } from "@/components/dashboard-section";
import {
  useRecentIssuesLimit,
  useRecentOpenIssues,
  useUnmergedPulls,
} from "@/queries/dashboard";
import { rootRoute } from "./root";

// Home (/) is a cross-project overview: pull requests still open and the most
// recently created open issues. Each row is tagged with its repo so it's clear
// which project the work belongs to. The per-repo dashboard lives at
// /r/:owner/:repo.
function HomePage() {
  const issues = useRecentOpenIssues();
  const pulls = useUnmergedPulls();
  const recentIssuesLimit = useRecentIssuesLimit().data;

  // Only hint at the cap once the list actually reaches it — below the cap the
  // note would be noise (or misread as "only N issues exist").
  const issuesCapped =
    recentIssuesLimit != null &&
    (issues.data?.length ?? 0) >= recentIssuesLimit;

  return (
    <div className="mx-auto flex max-w-content flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Open pull requests and the latest open issues, across all your
          projects.
        </p>
      </div>

      <DashboardSection
        title="Open pull requests"
        query={pulls}
        emptyText="No open pull requests."
        keyOf={(it) => `${it.repo.full_name}#${it.pull.number}`}
        renderItem={(it) => (
          <PullRow
            owner={it.repo.owner}
            repo={it.repo.name}
            pull={it.pull}
            repoLabel={it.repo.full_name}
          />
        )}
      />

      <DashboardSection
        title="Recent issues"
        query={issues}
        emptyText="No open issues."
        keyOf={(it) => `${it.repo.full_name}#${it.issue.number}`}
        renderItem={(it) => (
          <IssueRow
            owner={it.repo.owner}
            repo={it.repo.name}
            issue={it.issue}
            repoLabel={it.repo.full_name}
            showCreatedAt
          />
        )}
        footerNote={
          issuesCapped ? `Showing the ${recentIssuesLimit} most recent.` : null
        }
      />
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
