import { useNavigate } from "@tanstack/react-router";
import { Loader2, Search, Star, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Repo } from "@/api/types";
import {
  isEditableShortcutTarget,
  isShortcutOverlayActive,
} from "@/lib/keyboard-shortcuts";
import { compareSidebarRepos } from "@/lib/repo-sort";
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

export function RepoSwitcher({ openRequest = 0 }: { openRequest?: number }) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useRepos();
  const repos = useMemo(
    () => [...(data ?? [])].sort(compareSidebarRepos),
    [data],
  );
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filteredRepos = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return repos;
    return repos.filter((repo) => repo.full_name.toLowerCase().includes(query));
  }, [filter, repos]);
  const activeRepo = filteredRepos[activeIndex];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.key.toLowerCase() !== "k" ||
        !(event.metaKey || event.ctrlKey) ||
        isEditableShortcutTarget(event.target) ||
        isShortcutOverlayActive(event.target)
      ) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    setFilter("");
    const focusFrame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    focusFrame(() => filterRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex((current) =>
      filteredRepos.length === 0
        ? 0
        : Math.min(current, filteredRepos.length - 1),
    );
  }, [open, filteredRepos.length]);

  function close() {
    setOpen(false);
  }

  function go(repo: Repo | undefined) {
    if (!repo) return;
    const { owner, name } = splitRepoName(repo);
    close();
    navigate({ to: "/r/$owner/$repo", params: { owner, repo: name } });
  }

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredRepos.length === 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) =>
        Math.min(filteredRepos.length - 1, Math.max(0, current + direction)),
      );
      return;
    }
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return;
      if (
        event.target instanceof Element &&
        event.target.closest("button") != null
      ) {
        return;
      }
      event.preventDefault();
      if (filteredRepos.length === 0) return;
      go(filteredRepos[activeIndex]);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 px-4 pt-24"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Switch repository"
        tabIndex={-1}
        data-repo-switcher-dialog
        onKeyDown={onDialogKeyDown}
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-md border bg-background shadow-lg outline-none ring-1 ring-border"
      >
        <div className="flex h-12 items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden="true" />
          <input
            ref={filterRef}
            type="search"
            aria-label="Filter repositories"
            aria-describedby="repo-switcher-active"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Filter repositories"
            className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
          />
          <div
            id="repo-switcher-active"
            className="sr-only"
            aria-live="polite"
            aria-atomic="true"
          >
            {activeRepo
              ? `Selected repository: ${activeRepo.full_name}`
              : "No repository selected"}
          </div>
          <button
            type="button"
            aria-label="Close repository switcher"
            onClick={close}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </div>

        {isLoading && repos.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading repositories…
          </div>
        ) : isError && repos.length === 0 ? (
          <div className="p-4 text-sm text-destructive">
            Failed to load repositories.
          </div>
        ) : repos.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No repositories.
          </div>
        ) : filteredRepos.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No repositories match your filter.
          </div>
        ) : (
          <ul
            aria-label="Repositories"
            className="max-h-96 overflow-y-auto p-1"
          >
            {filteredRepos.map((repo, index) => (
              <RepoSwitcherOption
                key={repo.id}
                repo={repo}
                active={index === activeIndex}
                optionRef={(node) => {
                  optionRefs.current[index] = node;
                }}
                onActive={() => setActiveIndex(index)}
                onSelect={() => go(repo)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RepoSwitcherOption({
  repo,
  active,
  optionRef,
  onActive,
  onSelect,
}: {
  repo: Repo;
  active: boolean;
  optionRef: (node: HTMLButtonElement | null) => void;
  onActive: () => void;
  onSelect: () => void;
}) {
  const { owner, name } = splitRepoName(repo);
  const setFavorite = useSetRepoFavorite(owner, name);
  const favoriteLabel = repo.favorite
    ? "Remove from favorites"
    : "Add to favorites";

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm",
          active
            ? "bg-accent text-accent-foreground"
            : "text-foreground hover:bg-accent hover:text-accent-foreground",
        )}
        onMouseEnter={onActive}
      >
        <button
          id={`repo-switcher-${repo.id}`}
          ref={optionRef}
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 rounded-sm truncate text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {repo.full_name}
        </button>
        <button
          type="button"
          aria-label={`${favoriteLabel}: ${repo.full_name}`}
          aria-pressed={repo.favorite}
          disabled={setFavorite.isPending}
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
              : "opacity-0 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100",
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
      </div>
    </li>
  );
}
