// Bottom terminal pane, present on every screen and spanning the full window width (it sits below
// the sidebar, not beside it — see app-layout.tsx). Window-scoped by design: each browser tab runs
// its own independent terminals — there is no cross-window sync.
//
// The pane hosts one or more terminal *tabs*. Each tab is an independent PTY/WebSocket session
// (a TerminalView), kept mounted while it exists so switching tabs only hides the inactive ones
// (display toggle) — their shells keep running in the background. State to track:
//   - `tabs`: the live sessions. A tab exists from when it is created until its shell exits or the
//     user closes it (unmount → the PTY is killed). `tabs.length > 0` is the old single-session
//     `started` flag; an empty list returns the pane to the closed "nothing running" state.
//   - `expanded`: whether the terminal area is shown. Minimizing (expanded=false) only HIDES the
//     terminals — it keeps every tab mounted and its shell running, so it is NOT a terminate.
// `maximized` grows the area to nearly the full window height (a sliver of the app stays visible
// at the top). The pane stays collapsed by default so no screen auto-spawns a shell. `expanded`
// lives in sessionStorage (per browser tab); the pane height is cosmetic and shared via localStorage.
//
// The reload/close guard lives inside each TerminalView (gated on its own live socket), so with
// several mounted the browser prompts whenever *any* tab still has a live shell.
import {
  ChevronDown,
  ChevronUp,
  House,
  Maximize2,
  Minimize2,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type OpenTerminalOptions,
  type TerminalIssueRef,
  useRegisterTerminalController,
} from "@/components/terminal-controller";
import { TerminalPrHeader } from "@/components/terminal-pr-header";
import { TerminalView } from "@/components/terminal-view";
import { installTerminalDebugLogging, tlog } from "@/lib/terminal-debug";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { useRepos } from "@/queries/repos";

const EXPANDED_KEY = "lh.terminal.open"; // sessionStorage: per-tab expanded state
const HEIGHT_KEY = "lh.terminal.height"; // localStorage: shared cosmetic height
const MIN_H = 120;
const DEFAULT_H = 680; // ~40 rows at the 13px terminal font (capped to the viewport on open)
const BAR_H = 36; // the h-9 toggle bar
const TOP_GAP = 12; // sliver of the app kept visible above a maximized/tall terminal
const REST_GAP = 12; // breathing room kept between page content and the terminal top
const RESERVE = BAR_H + TOP_GAP; // viewport px reserved above the terminal content
const MAX_CONTENT = `calc(100dvh - ${RESERVE}px)`;
// CSS var the page layout reads to reserve bottom padding equal to the terminal's current visible
// height, so the always-on-top fixed overlay never hides the tail of a scrollable region.
const RESERVE_VAR = "--lh-term-reserve";

// One terminal tab: a stable id (React key) and the repo ("owner/name", or "" for $HOME) whose
// base dir is its cwd. The cwd is fixed at creation — TerminalView captures it once at mount.
// `command` is an optional one-shot run on start (New Issue / Build); `label` overrides the
// repo-derived tab label. `issueRef` (Build tabs only) drives the PR top region. All captured
// once at creation alongside the cwd.
type Tab = {
  id: string;
  repo: string;
  command?: string;
  label?: string;
  issueRef?: TerminalIssueRef;
};

function newId(): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `t-${Math.random().toString(36).slice(2)}`;
  // #275 diagnostics: a fresh tab id on sleep/resume means the SPA rebuilt the tab list (the
  // "reset" shape from a reload/remount), not that an existing session reconnected.
  tlog("newId (tab created)", { id });
  return id;
}

// Short tab label: the repo name (last path segment) or "~" for a $HOME shell.
function tabLabel(repo: string): string {
  if (!repo) return "~";
  const slash = repo.lastIndexOf("/");
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

function readHeight(): number {
  const v = Number(localStorage.getItem(HEIGHT_KEY));
  const base = Number.isFinite(v) && v >= MIN_H ? v : DEFAULT_H;
  // Clamp to the viewport so the height state matches what max-height actually renders — a
  // too-tall default/stored value would otherwise leave a dead zone on the first downward drag.
  return Math.min(base, Math.max(MIN_H, window.innerHeight - RESERVE));
}

export function TerminalPane() {
  // The repo of the route currently in view ("" on non-repo screens). Read live (not captured):
  // on a repo page the "+" opens a tab there directly; off a repo it opens the cwd-picker menu.
  const currentRepo = useCurrentRepo() ?? "";
  const { data: repos } = useRepos();

  // Restore the expanded preference per browser tab. On a reload the prior PTYs are gone, so a
  // pane that was expanded reopens with one fresh tab (cwd = the repo in view at first render);
  // a minimized pane reopens with no tabs.
  const [expanded, setExpanded] = useState(
    () => sessionStorage.getItem(EXPANDED_KEY) === "1",
  );
  const [tabs, setTabs] = useState<Tab[]>(() =>
    sessionStorage.getItem(EXPANDED_KEY) === "1"
      ? [{ id: newId(), repo: currentRepo }]
      : [],
  );
  const [activeId, setActiveId] = useState<string | null>(
    () => tabs[0]?.id ?? null,
  );
  const [maximized, setMaximized] = useState(false);
  const [height, setHeight] = useState(readHeight);
  const [menuOpen, setMenuOpen] = useState(false);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  const started = tabs.length > 0;
  // The PR top region (below) follows the active tab — it shows that tab's linked PR, so switching
  // tabs swaps the region with it. Only Build tabs carry an issueRef, so other tabs show none.
  const activeTab = tabs.find((t) => t.id === activeId);

  // #275 diagnostics: install the page-global lifecycle listeners (once) and log this pane's
  // mount/unmount. A TerminalPane remount on resume would itself reset every tab.
  useEffect(() => {
    installTerminalDebugLogging();
    tlog("TerminalPane mount");
    return () => tlog("TerminalPane unmount");
  }, []);

  useEffect(() => {
    sessionStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
  }, [expanded]);
  useEffect(() => {
    localStorage.setItem(HEIGHT_KEY, String(height));
  }, [height]);

  // Reconcile derived UI state from the authoritative tab list. This is the single owner of
  // "is activeId valid" and "did the last tab go", so removals don't each have to recompute a
  // neighbour from a possibly-stale snapshot — every path (single close, several shells exiting
  // in one tick, programmatic close) converges here. Layout effect so a just-removed activeId is
  // repointed before paint (no blank frame). When the list empties, fall back to the closed
  // "nothing running" state — the old single-session behaviour on shell exit.
  useLayoutEffect(() => {
    if (tabs.length === 0) {
      setActiveId(null);
      setExpanded(false);
      setMaximized(false);
      setMenuOpen(false);
    } else if (!tabs.some((t) => t.id === activeId)) {
      setActiveId(tabs[tabs.length - 1].id);
    }
  }, [tabs, activeId]);

  // Open a new tab and make it active + visible. With no options it opens a plain shell in $HOME;
  // callers pass a repo (cwd), an initial command to run on start, and/or a label override. This
  // is the imperative API published to the rest of the app via the terminal controller below.
  const openTerminal = useCallback((opts?: OpenTerminalOptions) => {
    const tab: Tab = {
      id: newId(),
      repo: opts?.repo ?? "",
      command: opts?.command,
      label: opts?.label,
      issueRef: opts?.issueRef,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setExpanded(true);
    setMenuOpen(false);
  }, []);

  // Publish openTerminal so the New Issue / Build buttons (and any future caller) can open a tab
  // with a command. Lives here because this component owns the tab list.
  useRegisterTerminalController(openTerminal);

  // Close a tab: removing it unmounts its TerminalView, which kills that PTY (other tabs are
  // untouched). activeId and collapse-on-empty are handled by the reconcile layout effect above.
  const closeTab = useCallback((id: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toggle = useCallback(() => {
    if (expanded) {
      // Minimizing leaves every tab running but drops the maximized state so a later peek-open
      // returns to the normal dragged height.
      setExpanded(false);
      setMaximized(false);
      setMenuOpen(false);
      return;
    }
    setExpanded(true);
    // Expanding with no tabs starts the first session (cwd = the repo in view). Compute the tab
    // outside the updater so the updater stays pure; the reconcile effect makes it active.
    const tab = { id: newId(), repo: currentRepo };
    setTabs((prev) => (prev.length > 0 ? prev : [tab]));
  }, [expanded, currentRepo]);

  const toggleMaximize = useCallback(() => setMaximized((v) => !v), []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      drag.current = { startY: e.clientY, startH: height };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [height],
  );
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Dragging up (smaller clientY) grows the pane, up to nearly the full window height.
    const max = Math.max(MIN_H, window.innerHeight - RESERVE);
    const next = Math.min(
      max,
      Math.max(MIN_H, d.startH + (d.startY - e.clientY)),
    );
    setHeight(next);
  }, []);
  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const contentHeight = !expanded ? 0 : maximized ? MAX_CONTENT : height;

  // The terminal is a fixed overlay along the bottom, so it never reflows the page. Publish its
  // current total visible height (bar + content) so scrollable regions can reserve that much
  // bottom padding and stay reachable past the terminal — collapsed, dragged, or maximized.
  const reserveCss = !expanded
    ? `${BAR_H + REST_GAP}px`
    : maximized
      ? `calc(100dvh - ${TOP_GAP}px)`
      : // The rendered terminal content is capped at MAX_CONTENT, but `height` is only clamped on
        // drag — a window shrink without a re-drag leaves it stale. Cap the reserve at the same
        // maximized limit so a tall stored height can't over-reserve a dead scroll zone.
        `min(${BAR_H + height + REST_GAP}px, 100dvh - ${TOP_GAP}px)`;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(RESERVE_VAR, reserveCss);
    // Wrap in a block so the cleanup returns void — removeProperty returns the removed value
    // (string), which a bare arrow body would make an invalid effect Destructor.
    return () => {
      root.style.removeProperty(RESERVE_VAR);
    };
  }, [reserveCss]);

  return (
    // Fixed full-width overlay pinned to the bottom: growing it never reflows the page behind it.
    // The bar sits on top of the (optional) content below, which is anchored to the viewport
    // bottom. `relative` is kept implicitly by `fixed` so the absolute resize handle anchors here.
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background">
      {expanded && !maximized && (
        // Invisible resize handle along the top of the bar (only when open). It draws nothing —
        // the visible separator is just the pane's normal border-t — but gives a row-resize grab
        // strip about a quarter of the bar's height. Absolutely positioned so it never changes the
        // bar height; minimized and open look identical.
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="absolute inset-x-0 top-0 z-10 h-2.5 cursor-row-resize"
          aria-hidden="true"
        />
      )}
      <div className="flex h-9 w-full items-center gap-1 px-3 text-xs text-muted-foreground">
        {/* Only the icon (and the chevron) toggle — clicking the bar itself does nothing. */}
        <button
          type="button"
          onClick={toggle}
          className="flex h-6 items-center gap-1.5 rounded px-1.5 hover:bg-muted hover:text-foreground"
          title={
            expanded
              ? "Minimize terminal"
              : started
                ? "Restore terminal (running)"
                : "Open terminal"
          }
        >
          <SquareTerminal className="size-3.5" />
          {/* Sessions are alive but hidden — mark it (with a count) so they stay discoverable. */}
          {started && !expanded && (
            <span
              className="flex items-center gap-1"
              aria-label={`${tabs.length} session${tabs.length === 1 ? "" : "s"} running`}
            >
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {tabs.length > 1 && (
                <span className="tabular-nums">{tabs.length}</span>
              )}
            </span>
          )}
        </button>
        {/* Tab strip (only when open). Each tab shows its label and a close button; the active
            tab is highlighted. The trailing "+" opens the new-tab cwd menu. */}
        {expanded && (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {/* Tabs scroll horizontally when they overflow; the "+" stays outside this
                scroll container so its upward-opening menu isn't clipped (an overflow-x
                container also clips the y-axis). */}
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              {tabs.map((t) => {
                const isActive = t.id === activeId;
                return (
                  <div
                    key={t.id}
                    className={`group flex h-6 max-w-40 shrink-0 items-center gap-1 rounded px-2 ${
                      isActive
                        ? "bg-muted text-foreground"
                        : "hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveId(t.id)}
                      className="truncate"
                      title={t.label || t.repo || "~ ($HOME)"}
                    >
                      {t.label || tabLabel(t.repo)}
                    </button>
                    <button
                      type="button"
                      onClick={() => closeTab(t.id)}
                      className="rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100"
                      title="Close tab"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="relative shrink-0">
              <button
                type="button"
                // On a repo-scoped page the cwd is unambiguous — open a tab there directly. Off a
                // repo (Home, archived, …) there is no obvious cwd, so let the user pick one.
                onClick={() =>
                  currentRepo
                    ? openTerminal({ repo: currentRepo })
                    : setMenuOpen((v) => !v)
                }
                className="flex size-6 items-center justify-center rounded hover:bg-muted hover:text-foreground"
                title={
                  currentRepo
                    ? `New terminal in ${currentRepo}`
                    : "New terminal…"
                }
              >
                <Plus className="size-3.5" />
              </button>
              {menuOpen && (
                <NewTabMenu
                  repos={(repos ?? []).map((r) => r.full_name)}
                  onPick={(repo) => openTerminal({ repo })}
                  onClose={() => setMenuOpen(false)}
                />
              )}
            </div>
          </div>
        )}
        {/* Inert spacer keeps the right controls pinned when there is no tab strip. */}
        {!expanded && <div className="flex-1" />}
        {expanded && (
          <button
            type="button"
            onClick={toggleMaximize}
            className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted hover:text-foreground"
            title={maximized ? "Restore terminal height" : "Maximize terminal"}
          >
            {maximized ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={toggle}
          className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted hover:text-foreground"
          title={expanded ? "Minimize terminal" : "Open terminal"}
        >
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronUp className="size-4" />
          )}
        </button>
      </div>
      {started && (
        // Kept mounted once any tab exists so minimizing (height 0) doesn't kill the shells. All
        // tabs stay mounted; only the active one is shown (display) so the others keep running.
        <div
          style={{ height: contentHeight, maxHeight: MAX_CONTENT }}
          className={`flex flex-col overflow-hidden ${expanded ? "border-t" : ""}`}
        >
          {/* PR top region for the active Build tab (#270). Above the terminals, follows the active
              tab. min-h-0 below lets the terminal area shrink so this never gets clipped. */}
          {expanded && activeTab?.issueRef && (
            <TerminalPrHeader issueRef={activeTab.issueRef} />
          )}
          <div className={`min-h-0 flex-1 ${expanded ? "px-2 py-1" : ""}`}>
            {tabs.map((t) => {
              const isActive = t.id === activeId;
              return (
                <div
                  key={t.id}
                  className="h-full w-full"
                  style={{ display: isActive ? "block" : "none" }}
                >
                  <TerminalView
                    repo={t.repo}
                    command={t.command}
                    active={expanded && isActive}
                    onExit={() => closeTab(t.id)}
                    debugId={t.id}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// New-tab cwd picker, opened from the "+" button only when off a repo-scoped page (on a repo
// page the "+" opens a tab in that repo directly, no menu). Offers a $HOME shell and every
// registered repo. Opens upward (the pane sits at the viewport bottom) and closes on an outside
// click or Escape.
function NewTabMenu({
  repos,
  onPick,
  onClose,
}: {
  repos: string[];
  onPick: (repo: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Held in a ref so the dismiss listeners are wired up once (empty deps) and aren't re-armed
  // each time the parent passes a fresh onClose closure.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    // Defer so the click that opened the menu doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onDown));
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      ref={ref}
      // Opens upward (the pane is at the viewport bottom) and rightward (left-0): the "+" sits
      // near the left edge, so a right-anchored menu would spill off-screen over the sidebar.
      className="absolute bottom-full left-0 z-50 mb-1 max-h-80 w-56 overflow-y-auto rounded-md border bg-popover p-1 text-xs shadow-md"
    >
      <button
        type="button"
        onClick={() => onPick("")}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
      >
        <House className="size-3.5 shrink-0" />
        <span>Home (~)</span>
      </button>
      {repos.length > 0 && (
        <>
          <div className="my-1 border-t" />
          {repos.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onPick(r)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
            >
              <SquareTerminal className="size-3.5 shrink-0 opacity-60" />
              <span className="truncate">{r}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
