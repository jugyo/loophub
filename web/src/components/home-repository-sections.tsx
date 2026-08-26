import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { DashboardRepository } from "@/api/types";
import { IssueRow } from "@/components/dashboard-rows";

function RepositoryLink({
  repository,
  children,
  className = "",
  search,
}: {
  repository: DashboardRepository;
  children?: ReactNode;
  className?: string;
  search?: { state: "all" };
}) {
  return (
    <Link
      to="/r/$owner/$repo"
      params={{
        owner: repository.repo.owner,
        repo: repository.repo.name,
      }}
      search={search}
      title={repository.repo.full_name}
      className={`hover:underline ${className}`}
    >
      {children ?? repository.repo.full_name}
    </Link>
  );
}

function RepositorySummary({
  repository,
}: {
  repository: DashboardRepository;
}) {
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      {repository.total_issues} issues · open {repository.open_issues} · closed{" "}
      {repository.closed_issues}
    </span>
  );
}

function RepositoryLimitNote({
  repository,
}: {
  repository: DashboardRepository;
}) {
  if (!repository.has_more) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Showing the latest {repository.issue_limit} issues. View all{" "}
      {repository.total_issues} issues in the issue list.
    </p>
  );
}

function RepositorySection({
  repository,
}: {
  repository: DashboardRepository;
}) {
  return (
    <section
      data-debug-component="HomeRepositorySection"
      className="flex flex-col gap-2"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="min-w-0 truncate text-sm font-semibold">
          <RepositoryLink repository={repository} />
        </h2>
        <RepositorySummary repository={repository} />
      </header>

      {repository.issues.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">
          No issues.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {repository.issues.map((issue) => (
            <li key={issue.number}>
              <IssueRow
                owner={repository.repo.owner}
                repo={repository.repo.name}
                issue={issue}
                showCreatedAt
                showState
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3">
        <RepositoryLimitNote repository={repository} />
        <RepositoryLink
          repository={repository}
          className="shrink-0 text-xs text-muted-foreground"
          search={{ state: "all" }}
        >
          View issue list
        </RepositoryLink>
      </div>
    </section>
  );
}

export function HomeRepositorySections({
  repositories,
}: {
  repositories: DashboardRepository[];
}) {
  return (
    <div
      data-debug-component="HomeRepositorySections"
      className="flex flex-col gap-6"
    >
      {repositories.map((repository) => (
        <RepositorySection
          key={repository.repo.full_name}
          repository={repository}
        />
      ))}
    </div>
  );
}
