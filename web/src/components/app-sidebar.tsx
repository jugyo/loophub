// Sidebar: active repo list (GET /user/repos, archived excluded — same as v1),
// plus global utility links. Repo screens land in later UI issues.

import { Link } from "@tanstack/react-router";
import { Activity, Bot, Database, Loader2, Settings, Star } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { HerdrSessions, Repo } from "@/api/types";
import { Logo } from "@/components/logo";
import { SidebarHerdrSessions } from "@/components/sidebar-herdr-sessions";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { useRepos, useSetRepoFavorite } from "@/queries/repos";
import { useHerdrSessions } from "@/queries/terminal";

// Draggable sidebar width (#378). The width is a CSS variable (`--lh-sidebar-w`, default 16rem);
// dragging the right edge updates it live and persists the pixel value to localStorage so it
// survives a reload.
const WIDTH_KEY = "lh.sidebar.width"; // localStorage: shared cosmetic width (px)
const MIN_W = 180;
const MAX_W = 480;
const DEFAULT_W = 256; // 16rem — matches the CSS fallback in index.css

function readWidth(): number {
  const v = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(v) && v >= MIN_W ? Math.min(v, MAX_W) : DEFAULT_W;
}

export function AppSidebar() {
  const { data: repos, isLoading, isError } = useRepos();
  const { data: herdrSessions, isError: herdrSessionsError } =
    useHerdrSessions();

  const [width, setWidth] = useState(readWidth);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  // Publish the width as a CSS var so the sidebar's own layout follows it. Applied in a layout
  // effect so the restored width paints without a flash.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--lh-sidebar-w", `${width}px`);
  }, [width]);
  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);
  // Drop the inline override on unmount so a layout without the sidebar falls back to the
  // index.css default.
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty("--lh-sidebar-w");
    };
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      drag.current = { startX: e.clientX, startW: width };
      e.currentTarget.setPointerCapture(e.pointerId);
      // Keep the col-resize cursor and suppress text selection while dragging anywhere.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width],
  );
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.min(
      MAX_W,
      Math.max(MIN_W, d.startW + (e.clientX - d.startX)),
    );
    setWidth(next);
  }, []);
  // End the drag and restore the global styles. Bound to pointerup AND pointercancel/lost-capture
  // so an interrupted drag (touch/pen cancel, OS interruption, stolen capture) can't leave the
  // page stuck with a col-resize cursor and text selection disabled.
  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  return (
    <aside className="relative flex h-full w-[var(--lh-sidebar-w)] shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center justify-between gap-2 border-b px-4">
        <Link to="/" className="flex items-center gap-2 text-lg font-semibold">
          <Logo className="size-6" />
          LoopHub
        </Link>
        <IconSidebarLink to="/settings" label="Settings">
          <Settings className="size-4" />
        </IconSidebarLink>
      </div>

      <div className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Repositories
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && (
          <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        {isError && (
          <div className="px-2 py-2 text-sm text-destructive">
            Failed to load repositories.
          </div>
        )}
        {repos?.length === 0 && (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            No repositories.
          </div>
        )}
        {/* Favorites first (#457) so frequently-used repos stay at the top of the nav. */}
        {[...(repos ?? [])].sort(compareSidebarRepos).map((repo) => (
          <RepoSidebarLink
            key={repo.id}
            repo={repo}
            agentCount={
              herdrSessionsError
                ? 0
                : countRepoHerdrAgents(herdrSessions, repo.full_name)
            }
          />
        ))}

        {/* Archived (#478): sits directly under the repo list (inside the same scroll area, right
            after the last item) rather than pinned to the sidebar bottom — de-emphasized styling
            (small, muted, no icon) since it's an occasional escape hatch, not a top-level nav item.
            The arrow glyph (not a lucide icon, to keep the issue's "no icon" requirement) sets it
            apart from the repo rows above it, which it would otherwise visually blend into. */}
        <Link
          to="/archived"
          className="mt-1 block truncate rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          activeProps={{
            className: "bg-accent text-accent-foreground font-medium",
          }}
        >
          <span aria-hidden="true">→</span> Archived
        </Link>

        {/* Running herdr sessions grouped by repo (#495). Sits under the repo list inside the
            same scroll area; renders nothing when herdr isn't in use. */}
        <SidebarHerdrSessions />
      </div>

      {/* Fixed footer (#371): the theme toggle lives here, below the scrolling repo list. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t p-2">
        <ThemeToggle />
        <div className="flex items-center gap-1">
          <IconSidebarLink to="/stats" label="Stats">
            <Database className="size-4" />
          </IconSidebarLink>
          <IconSidebarLink to="/debug/events" label="Event debug">
            <Activity className="size-4" />
          </IconSidebarLink>
        </div>
      </div>

      {/* Drag handle along the sidebar's right edge (#378). Invisible — the visible separator is
          the aside's own border-r — but gives a col-resize grab strip straddling the border.
          Absolutely positioned so it never affects the sidebar's layout width. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute inset-y-0 right-0 z-10 w-1.5 translate-x-1/2 cursor-col-resize"
        aria-hidden="true"
      />
    </aside>
  );
}

export function countRepoHerdrAgents(
  sessions: HerdrSessions | undefined,
  repoFullName: string,
): number {
  return (
    sessions?.repos
      .filter((group) => group.repo === repoFullName)
      .reduce((total, group) => total + group.agents.length, 0) ?? 0
  );
}

export function compareSidebarRepos(a: Repo, b: Repo): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
  return a.full_name.localeCompare(b.full_name, undefined, {
    sensitivity: "base",
  });
}

function IconSidebarLink({
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
        "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
      activeProps={{
        className: "bg-accent text-accent-foreground",
      }}
      activeOptions={{ exact: to === "/" }}
    >
      {children}
    </Link>
  );
}

// Repo nav row with an inline favorite toggle (#457). Unlike SidebarLink, the star sits
// outside the <Link> (nesting a <button> inside an <a> is invalid) but inside the same
// hover/active-styled row, so favoriting doesn't require leaving the sidebar.
function RepoSidebarLink({
  repo,
  agentCount,
}: {
  repo: Repo;
  agentCount: number;
}) {
  const [owner, name] = repo.full_name.split("/");
  const setFavorite = useSetRepoFavorite(owner, name);
  const to: string = `/r/${owner}/${name}`;
  const agentLabel = `${agentCount} running ${
    agentCount === 1 ? "agent" : "agents"
  }`;

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md hover:bg-accent hover:text-accent-foreground",
        // Link sets `data-status="active"` on itself when its route matches (#472); extending
        // the highlight to the whole row (star button included) via `has-*` avoids duplicating
        // Link's active-route matching here.
        "has-[[data-status=active]]:bg-accent has-[[data-status=active]]:text-accent-foreground has-[[data-status=active]]:font-medium",
      )}
    >
      <Link
        to={to}
        title={repo.full_name}
        className="flex min-w-0 flex-1 items-center gap-2 truncate px-2 py-1.5 text-sm"
      >
        <span className="truncate">{repo.full_name}</span>
      </Link>
      {agentCount > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          aria-label={agentLabel}
          title={agentLabel}
        >
          <Bot className="size-3.5" aria-hidden="true" />
          <span>{agentCount}</span>
        </span>
      )}
      <button
        type="button"
        aria-label={
          repo.favorite ? "Remove from favorites" : "Add to favorites"
        }
        aria-pressed={repo.favorite}
        disabled={setFavorite.isPending}
        onClick={() => setFavorite.mutate(!repo.favorite)}
        className={cn(
          "shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground disabled:opacity-50",
          repo.favorite ? "" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <Star
          className={cn(
            "size-3.5",
            repo.favorite
              ? "fill-current text-yellow-600/70 dark:text-yellow-300/70"
              : "",
          )}
        />
      </button>
    </div>
  );
}
