import { createRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { HomeLabelFilter } from "@/components/home-label-filter";
import { HomeRepositorySections } from "@/components/home-repository-sections";
import { usePageTitle } from "@/lib/page-title";
import { useDashboardOverview } from "@/queries/dashboard";
import { rootRoute } from "./root";

export function HomePage() {
  usePageTitle(["Home"]);
  const { labels: labelsParam = "" } = useSearch({ strict: false }) as {
    labels?: string;
  };
  const selectedLabels = labelsParam
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const overview = useDashboardOverview(selectedLabels);
  const navigate = useNavigate();

  function navigateWithLabels(labels: string[]) {
    navigate({
      to: "/",
      search: labels.length > 0 ? { labels: labels.join(",") } : {},
    });
  }

  return (
    <div
      data-debug-component="HomePage"
      className="mx-auto flex max-w-content flex-col gap-8"
    >
      <div>
        <h1 className="text-2xl font-semibold">Repository issues</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Review issue status and work across active repositories.
        </p>
        {overview.data ? (
          <div className="mt-4">
            <HomeLabelFilter
              labels={overview.data.labels}
              selectedLabels={selectedLabels}
              onChange={navigateWithLabels}
              disabled={overview.isFetching}
            />
          </div>
        ) : null}
      </div>

      {overview.isLoading ? (
        <p className="py-8 text-sm text-muted-foreground">Loading…</p>
      ) : overview.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load repository issues.
          {overview.error instanceof Error
            ? ` ${overview.error.message}`
            : null}
        </div>
      ) : overview.data ? (
        <>
          <div className="border-b pb-4 text-sm">
            <span className="font-medium">Overview</span>
            <span className="ml-3 text-muted-foreground">
              {overview.data.repository_count} repositories ·{" "}
              {overview.data.total_issues} issues · open{" "}
              {overview.data.total_open_issues} · closed{" "}
              {overview.data.total_closed_issues}
            </span>
          </div>

          {overview.data.repositories.length === 0 ? (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No active repositories.
            </p>
          ) : (
            <HomeRepositorySections repositories={overview.data.repositories} />
          )}
        </>
      ) : null}
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
  validateSearch: validateHomeSearch,
});

export function validateHomeSearch(search: Record<string, unknown>): {
  labels?: string;
} {
  const labels = typeof search.labels === "string" ? search.labels.trim() : "";
  return labels ? { labels } : {};
}
