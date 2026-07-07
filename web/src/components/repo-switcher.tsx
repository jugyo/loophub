import { useNavigate } from "@tanstack/react-router";
import { Loader2, Search, X } from "lucide-react";
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

export function RepoSwitcher() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useRepos();
  const repos = useMemo(
    () => [...(data ?? [])].sort(compareSidebarRepos),
    [data],
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
    if (!open) return;
    setActiveIndex(0);
    const focusFrame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    focusFrame(() => dialogRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex((current) =>
      repos.length === 0 ? 0 : Math.min(current, repos.length - 1),
    );
  }, [open, repos.length]);

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
    if (
      event.key === "j" ||
      event.key === "ArrowDown" ||
      event.key === "k" ||
      event.key === "ArrowUp"
    ) {
      event.preventDefault();
      if (repos.length === 0) return;
      const direction = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) =>
        Math.min(repos.length - 1, Math.max(0, current + direction)),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (repos.length === 0) return;
      go(repos[activeIndex]);
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
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            Switch repository
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

        {isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading repositories…
          </div>
        ) : isError ? (
          <div className="p-4 text-sm text-destructive">
            Failed to load repositories.
          </div>
        ) : repos.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No repositories.
          </div>
        ) : (
          <ul
            role="listbox"
            aria-label="Repositories"
            aria-activedescendant={
              repos[activeIndex]
                ? `repo-switcher-${repos[activeIndex].id}`
                : undefined
            }
            className="max-h-96 overflow-y-auto p-1"
          >
            {repos.map((repo, index) => (
              <li
                key={repo.id}
                role="option"
                aria-selected={index === activeIndex}
              >
                <button
                  id={`repo-switcher-${repo.id}`}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => go(repo)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-sm",
                    index === activeIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <span className="min-w-0 truncate">{repo.full_name}</span>
                  {repo.favorite ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Favorite
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
