import { Link } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  Command,
  Inbox,
  Loader2,
  Settings,
} from "lucide-react";
import { useMemo } from "react";
import { Logo } from "@/components/logo";
import { NotificationCenter } from "@/components/notification-center";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { compareSidebarRepos } from "@/lib/repo-sort";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { cn } from "@/lib/utils";
import { useRepos } from "@/queries/repos";
import { useAgentCostSummary } from "@/queries/sessions";

export function AppTopbar({
  onOpenRepoSwitcher,
}: {
  onOpenRepoSwitcher?: () => void;
}) {
  const currentRepo = useCurrentRepo();
  const { data, isLoading, isError } = useRepos();
  const { data: costSummary } = useAgentCostSummary();
  const repos = useMemo(
    () => [...(data ?? [])].sort(compareSidebarRepos),
    [data],
  );
  const currentRepoInList =
    currentRepo != null && repos.some((repo) => repo.full_name === currentRepo);
  const selectedRepoLabel = currentRepoInList ? currentRepo : "";
  const repositoryLabel = selectedRepoLabel
    ? `Repository: ${selectedRepoLabel}`
    : "Repository";

  return (
    <header className="flex h-14 shrink-0 items-center border-b bg-card px-2 py-2 sm:px-4">
      <div
        className="flex h-9 w-full items-center gap-2 sm:gap-3"
        role="group"
        aria-label="Primary topbar"
      >
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-base font-semibold hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Logo className="size-6" />
          <span className="hidden sm:inline">LoopHub</span>
        </Link>

        <div className="min-w-0 flex-none w-20 sm:w-auto sm:flex-1 sm:max-w-80">
          <Button
            type="button"
            variant="secondary"
            aria-label={repositoryLabel}
            title="Switch repository"
            onClick={onOpenRepoSwitcher}
            className="h-9 w-full justify-between border bg-background px-3 text-left font-normal shadow-sm"
          >
            <span
              className={cn(
                "min-w-0 truncate",
                selectedRepoLabel ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {selectedRepoLabel ||
                (isLoading
                  ? "Loading repositories..."
                  : isError
                    ? "Failed to load repositories"
                    : "Select repository")}
            </span>
            <span className="ml-2 inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <>
                  <Command className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">K</span>
                </>
              )}
            </span>
          </Button>
        </div>

        <div className="hidden min-w-4 flex-1 md:block" aria-hidden="true" />

        <TokenRateBadge
          tokensPer5Minutes={topbarTokensPer5Minutes(costSummary)}
        />
        <TopbarLink to="/inbox" label="Inbox">
          <Inbox className="size-4" />
        </TopbarLink>
        <TopbarLink to="/stats" label="Stats">
          <BarChart3 className="size-4" />
        </TopbarLink>
        <TopbarLink to="/settings" label="Settings">
          <Settings className="size-4" />
        </TopbarLink>
        <NotificationCenter />
        <ThemeToggle />
      </div>
    </header>
  );
}

function topbarTokensPer5Minutes(
  summary: Array<{ tokens_per_5m_history?: number[] }> | undefined,
): number[] | null {
  const history = summary?.find(
    (row) => row.tokens_per_5m_history,
  )?.tokens_per_5m_history;
  if (!history) return null;
  return history.map((value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0,
  );
}

function formatTokensPerFiveMinutes(value: number | null): string {
  if (value == null) return "n/a";
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toLocaleString();
}

function TokenRateBadge({
  tokensPer5Minutes,
}: {
  tokensPer5Minutes: number[] | null;
}) {
  const current = tokensPer5Minutes?.at(-1) ?? null;
  const value = formatTokensPerFiveMinutes(current);
  return (
    <div
      className="hidden h-9 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2 text-xs text-muted-foreground shadow-sm md:inline-flex"
      title={
        current == null
          ? "Token rate unavailable"
          : "Average aggregate token rate over the current five-minute bucket"
      }
      aria-label={`Average token rate: ${value} tokens per 5 minutes`}
    >
      <Activity className="size-3.5" aria-hidden="true" />
      <span className="font-mono text-foreground">{value}</span>
      <span>avg tokens / 5m</span>
      {tokensPer5Minutes && <TokenHistoryBars values={tokensPer5Minutes} />}
    </div>
  );
}

function TokenHistoryBars({ values }: { values: number[] }) {
  const max = Math.max(...values, 0);
  return (
    <span
      className="ml-1 flex h-5 w-20 items-end gap-px"
      role="img"
      aria-label={`${values.length} five-minute token buckets, oldest to newest`}
    >
      {values.map((value, index) => (
        <span
          // Bucket order is meaningful and fixed, so the index is its stable identity.
          key={index}
          className="min-w-0 flex-1 rounded-sm bg-primary/70"
          data-token-count={value}
          style={{
            height: max === 0 ? "0%" : `${(value / max) * 100}%`,
            minHeight: value > 0 ? "2px" : undefined,
          }}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function TopbarLink({
  to,
  label,
  children,
}: {
  to: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:px-3"
      activeProps={{
        className: "bg-accent text-accent-foreground",
      }}
    >
      {children}
      <span className="hidden lg:inline">{label}</span>
    </Link>
  );
}
