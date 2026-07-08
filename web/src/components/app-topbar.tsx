import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  ChevronsUpDown,
  Inbox,
  Loader2,
  Settings,
  Star,
} from "lucide-react";
import { useMemo } from "react";
import type { Repo } from "@/api/types";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { compareSidebarRepos } from "@/lib/repo-sort";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { cn } from "@/lib/utils";
import { useRepos, useSetRepoFavorite } from "@/queries/repos";

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
  const currentRepoInList =
    currentRepo != null && repos.some((repo) => repo.full_name === currentRepo);
  const selectedRepoLabel = currentRepoInList ? currentRepo : "";
  const favoriteRepos = repos.filter((repo) => repo.favorite);
  const otherRepos = repos.filter((repo) => !repo.favorite);
  const disabled = isLoading || repos.length === 0;
  const repositoryLabel = selectedRepoLabel
    ? `Repository: ${selectedRepoLabel}`
    : "Repository";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-2 sm:gap-3 sm:px-4">
      <Link
        to="/"
        className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-base font-semibold hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Logo className="size-6" />
        <span className="hidden sm:inline">LoopHub</span>
      </Link>

      <div className="min-w-0 flex-none w-20 sm:w-auto sm:flex-1 sm:max-w-80">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              aria-label={repositoryLabel}
              title="Switch repository"
              disabled={disabled}
              className="h-9 w-full justify-between border bg-background px-3 text-left font-normal shadow-sm"
            >
              <span
                className={cn(
                  "min-w-0 truncate",
                  selectedRepoLabel
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {selectedRepoLabel ||
                  (isLoading
                    ? "Loading repositories..."
                    : isError
                      ? "Failed to load repositories"
                      : "Select repository")}
              </span>
              {isLoading ? (
                <Loader2
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <ChevronsUpDown
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[min(28rem,calc(100vh-5rem))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-72 overflow-y-auto"
          >
            <RepoMenuGroup
              label={favoriteRepos.length > 0 ? "Favorites" : "Repositories"}
              repos={favoriteRepos.length > 0 ? favoriteRepos : otherRepos}
              currentRepo={currentRepo}
              onSelect={(repo) => {
                const { owner, name } = splitRepoName(repo);
                navigate({
                  to: "/r/$owner/$repo",
                  params: { owner, repo: name },
                });
              }}
            />
            {favoriteRepos.length > 0 && otherRepos.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <RepoMenuGroup
                  label="Other repositories"
                  repos={otherRepos}
                  currentRepo={currentRepo}
                  onSelect={(repo) => {
                    const { owner, name } = splitRepoName(repo);
                    navigate({
                      to: "/r/$owner/$repo",
                      params: { owner, repo: name },
                    });
                  }}
                />
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
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
    </header>
  );
}

function RepoMenuGroup({
  label,
  repos,
  currentRepo,
  onSelect,
}: {
  label: string;
  repos: Repo[];
  currentRepo: string | null;
  onSelect: (repo: Repo) => void;
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {repos.map((repo) => {
        const selected = repo.full_name === currentRepo;
        return (
          <RepoMenuItem
            key={repo.id}
            repo={repo}
            selected={selected}
            onSelect={onSelect}
          />
        );
      })}
    </DropdownMenuGroup>
  );
}

function RepoMenuItem({
  repo,
  selected,
  onSelect,
}: {
  repo: Repo;
  selected: boolean;
  onSelect: (repo: Repo) => void;
}) {
  const { owner, name } = splitRepoName(repo);
  const setFavorite = useSetRepoFavorite(owner, name);
  const favoriteLabel = repo.favorite
    ? "Remove from favorites"
    : "Add to favorites";

  return (
    <DropdownMenuItem
      onSelect={() => onSelect(repo)}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "group min-h-10 justify-between gap-3",
        selected && "bg-accent text-accent-foreground",
      )}
    >
      <span className="min-w-0 truncate">{repo.full_name}</span>
      <button
        type="button"
        aria-label={`${favoriteLabel}: ${repo.full_name}`}
        aria-pressed={repo.favorite}
        disabled={setFavorite.isPending}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setFavorite.mutate(!repo.favorite);
        }}
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          repo.favorite
            ? "text-yellow-600 hover:text-yellow-700 dark:text-yellow-300 dark:hover:text-yellow-200"
            : "opacity-0 hover:text-foreground group-hover:opacity-100 group-focus:opacity-100 group-data-[highlighted]:opacity-100",
        )}
      >
        <Star
          className={cn(
            "size-4",
            repo.favorite &&
              "fill-yellow-400 dark:fill-yellow-300 dark:text-yellow-300",
          )}
          aria-hidden="true"
        />
      </button>
    </DropdownMenuItem>
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
