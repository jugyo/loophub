import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Archive,
  BarChart3,
  ChevronsUpDown,
  Loader2,
  Settings,
} from "lucide-react";
import { useMemo } from "react";
import type { Repo } from "@/api/types";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { compareSidebarRepos } from "@/lib/repo-sort";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { cn } from "@/lib/utils";
import { useRepos } from "@/queries/repos";

function splitRepoName(repo: Repo): { owner: string; name: string } {
  const slash = repo.full_name.indexOf("/");
  return slash === -1
    ? { owner: repo.owner.login, name: repo.name }
    : {
        owner: repo.full_name.slice(0, slash),
        name: repo.full_name.slice(slash + 1),
      };
}

export function AppTopbar() {
  const navigate = useNavigate();
  const currentRepo = useCurrentRepo();
  const { data, isLoading, isError } = useRepos();
  const repos = useMemo(
    () => [...(data ?? [])].sort(compareSidebarRepos),
    [data],
  );
  const currentRepoInList = repos.some(
    (repo) => repo.full_name === currentRepo,
  );
  const selectValue = currentRepoInList ? currentRepo : "";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-2 sm:gap-3 sm:px-4">
      <Link
        to="/"
        className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-base font-semibold hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Logo className="size-6" />
        <span className="hidden sm:inline">LoopHub</span>
      </Link>

      <div className="relative min-w-0 flex-none w-20 sm:w-auto sm:flex-1 sm:max-w-80">
        <select
          aria-label="Repository"
          title="Switch repository"
          value={selectValue}
          disabled={isLoading || repos.length === 0}
          onChange={(event) => {
            const repo = repos.find(
              (candidate) => candidate.full_name === event.target.value,
            );
            if (!repo) return;
            const { owner, name } = splitRepoName(repo);
            navigate({ to: "/r/$owner/$repo", params: { owner, repo: name } });
          }}
          className={cn(
            "h-9 w-full appearance-none truncate rounded-md border bg-background py-1.5 pl-3 pr-9 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
            selectValue ? "" : "text-muted-foreground",
          )}
        >
          <option value="">
            {isLoading
              ? "Loading repositories..."
              : isError
                ? "Failed to load repositories"
                : "Select repository"}
          </option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.full_name}>
              {repo.full_name}
            </option>
          ))}
        </select>
        {isLoading ? (
          <Loader2
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <ChevronsUpDown
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </div>

      <IconTopbarLink to="/archived" label="Archived repositories">
        <Archive className="size-4" />
      </IconTopbarLink>

      <div className="hidden min-w-4 flex-1 md:block" aria-hidden="true" />

      <ThemeToggle />
      <TopbarLink to="/stats" label="Stats">
        <BarChart3 className="size-4" />
      </TopbarLink>
      <TopbarLink to="/debug/events" label="Events">
        <Activity className="size-4" />
      </TopbarLink>
      <TopbarLink to="/settings" label="Settings">
        <Settings className="size-4" />
      </TopbarLink>
    </header>
  );
}

function IconTopbarLink({
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
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
      activeProps={{
        className: "bg-accent text-accent-foreground",
      }}
    >
      {children}
    </Link>
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
