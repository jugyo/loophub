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
import type { AgentCostSummary } from "@/api/types";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { CODING_AGENT_LABELS } from "@/lib/agent-models";
import { compareSidebarRepos } from "@/lib/repo-sort";
import { formatCost } from "@/lib/session-usage";
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
    <header className="flex shrink-0 flex-col gap-2 border-b bg-card px-2 py-2 sm:px-4">
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

        <TopbarLink to="/inbox" label="Inbox">
          <Inbox className="size-4" />
        </TopbarLink>
        <TopbarLink to="/stats" label="Stats">
          <BarChart3 className="size-4" />
        </TopbarLink>
        <TopbarLink to="/debug/events" label="Events">
          <Activity className="size-4" />
        </TopbarLink>
        <TopbarLink to="/settings" label="Settings">
          <Settings className="size-4" />
        </TopbarLink>
        <ThemeToggle />
      </div>
      <div
        className="hidden min-h-7 w-full items-center justify-end md:flex"
        role="group"
        aria-label="Secondary topbar"
      >
        <TopbarAgentCosts />
      </div>
    </header>
  );
}

type PeriodKey = "month" | "week" | "day";

const PERIOD_LABELS: Record<PeriodKey, string> = {
  month: "Month",
  week: "Week",
  day: "Today",
};

function TopbarAgentCosts() {
  const { data: summaries = [], isLoading, isError } = useAgentCostSummary();

  return (
    <div
      className="flex max-w-[34rem] shrink min-w-0 items-center gap-2 rounded-md border bg-background/70 px-2 py-1 text-[11px] leading-tight text-muted-foreground"
      aria-label="Agent cost summary"
    >
      <span className="shrink-0 font-medium text-foreground">Cost</span>
      {isLoading ? (
        <span className="tabular-nums">Loading...</span>
      ) : isError ? (
        <span className="tabular-nums">n/a</span>
      ) : (
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {summaries.map((summary) => (
            <AgentCostRow key={summary.agent} summary={summary} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCostRow({ summary }: { summary: AgentCostSummary }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <span className="font-medium text-foreground">
        {CODING_AGENT_LABELS[summary.agent]}
      </span>
      {(["month", "week", "day"] as const).map((period) => (
        <span key={period} title={PERIOD_LABELS[period]}>
          {PERIOD_LABELS[period][0]}{" "}
          <span className="tabular-nums">{formatCost(summary[period])}</span>
        </span>
      ))}
    </div>
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
