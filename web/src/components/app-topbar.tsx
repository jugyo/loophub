import { Link } from "@tanstack/react-router";
import { BarChart3, Command, Inbox, Loader2, Settings } from "lucide-react";
import { useMemo } from "react";
import { ComponentDebugToggle } from "@/components/component-debug-overlay";
import { Logo } from "@/components/logo";
import { NotificationCenter } from "@/components/notification-center";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { compareSidebarRepos } from "@/lib/repo-sort";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { cn } from "@/lib/utils";
import { useWebConfig } from "@/lib/web-config";
import { useRepos } from "@/queries/repos";

export function AppTopbar({
  onOpenRepoSwitcher,
}: {
  onOpenRepoSwitcher?: () => void;
}) {
  const currentRepo = useCurrentRepo();
  const { experimental } = useWebConfig();
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
    <header
      data-debug-component="AppTopbar"
      className="flex h-14 shrink-0 items-center border-b bg-card px-2 py-2 sm:px-4"
    >
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

        {experimental ? (
          <TopbarLink to="/inbox" label="Inbox">
            <Inbox className="size-4" />
          </TopbarLink>
        ) : null}
        <TopbarLink to="/stats" label="Stats">
          <BarChart3 className="size-4" />
        </TopbarLink>
        <TopbarLink to="/settings" label="Settings">
          <Settings className="size-4" />
        </TopbarLink>
        <NotificationCenter />
        <ThemeToggle />
        <ComponentDebugToggle />
      </div>
    </header>
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
