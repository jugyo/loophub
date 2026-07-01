// Sidebar: active repo list (GET /user/repos, archived excluded — same as v1),
// plus links to Home and Archived. Repo screens land in later UI issues.

import { Link } from "@tanstack/react-router";
import { Archive, Home, Loader2 } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { useRepos } from "@/queries/repos";

// Draggable sidebar width (#378). The width is a CSS variable (`--lh-sidebar-w`, default 16rem)
// shared by the sidebar and the bottom terminal pane's left offset; dragging the right edge
// updates it live and persists the pixel value to localStorage so it survives a reload.
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

  const [width, setWidth] = useState(readWidth);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  // Publish the width as the shared CSS var so the sidebar and the terminal pane's left offset
  // both follow it. Applied in a layout effect so the restored width paints without a flash.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--lh-sidebar-w", `${width}px`);
  }, [width]);
  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);
  // Drop the inline override on unmount so a layout without the sidebar falls back to the
  // index.css default (otherwise the terminal pane's left offset keeps the last width).
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
      <div className="flex h-14 items-center px-4">
        <Link
          to="/"
          className="text-lg font-semibold text-red-600 dark:text-red-400"
        >
          LoopHub
        </Link>
      </div>

      <nav className="flex flex-col gap-1 p-2">
        <SidebarLink to="/" icon={<Home className="size-4" />}>
          Home
        </SidebarLink>
        <SidebarLink to="/archived" icon={<Archive className="size-4" />}>
          Archived
        </SidebarLink>
      </nav>

      <div className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Repositories
      </div>

      {/* The terminal pane now sits beside the sidebar (it starts at the sidebar's right edge),
          so it no longer overlays the sidebar bottom and no extra clearance is needed. */}
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
        {repos?.map((repo) => {
          const [owner, name] = repo.full_name.split("/");
          return (
            <SidebarLink
              key={repo.id}
              to={`/r/${owner}/${name}`}
              title={repo.full_name}
            >
              <span className="truncate">{repo.full_name}</span>
            </SidebarLink>
          );
        })}
      </div>

      {/* Fixed footer (#371): the theme toggle lives here, below the scrolling repo list. The
          terminal pane sits beside the sidebar (not over it), so this footer stays visible. */}
      <div className="shrink-0 border-t p-2">
        <ThemeToggle />
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

function SidebarLink({
  to,
  icon,
  title,
  children,
}: {
  to: string;
  icon?: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      title={title}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
      )}
      activeProps={{
        className: "bg-accent text-accent-foreground font-medium",
      }}
      activeOptions={{ exact: to === "/" }}
    >
      {icon}
      {children}
    </Link>
  );
}
