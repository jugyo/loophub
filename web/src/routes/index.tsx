import { createRoute } from "@tanstack/react-router";
import { IssueRow, PullRow } from "@/components/dashboard-rows";
import { DashboardSection } from "@/components/dashboard-section";
import { useInProgressIssues, useUnmergedPulls } from "@/queries/dashboard";
import { rootRoute } from "./root";

// Home (/) is a cross-project overview: issues currently being worked on and
// pull requests still open. Each row is tagged with its repo so it's clear which
// project the work belongs to. The per-repo dashboard lives at /r/:owner/:repo.
function HomePage() {
  const issues = useInProgressIssues();
  const pulls = useUnmergedPulls();

  return (
    <div className="mx-auto flex max-w-content flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Issues in progress and pull requests awaiting merge, across all your
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
        title="In progress"
        query={issues}
        emptyText="No issues are being worked on right now."
        keyOf={(it) => `${it.repo.full_name}#${it.issue.number}`}
        renderItem={(it) => (
          <IssueRow
            owner={it.repo.owner}
            repo={it.repo.name}
            issue={it.issue}
            repoLabel={it.repo.full_name}
          />
        )}
      />
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
