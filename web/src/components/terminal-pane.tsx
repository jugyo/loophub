// Bottom terminal pane, present on every screen and spanning the full window width (it sits below
// the sidebar, not beside it — see app-layout.tsx). Window-scoped by design: each browser tab runs
// its own independent session — there is no cross-window sync.
//
// Two separate notions of state:
//   - `started`: a live PTY/WebSocket session exists. It starts when the user first expands the
//     pane, persists across all navigation, and ends ONLY on shell exit or a page reload.
//   - `expanded`: whether the terminal area is shown. Minimizing (expanded=false) only HIDES the
//     terminal — it keeps the session mounted and the shell running, so it is NOT a terminate.
// `maximized` grows the area to nearly the full window height (a sliver of the app stays visible
// at the top). The session stays collapsed by default so no screen auto-spawns a shell. `expanded`
// lives in sessionStorage (per tab); the pane height is cosmetic and shared via localStorage.
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  SquareTerminal,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { TerminalView } from "@/components/terminal-view";

const EXPANDED_KEY = "lh.terminal.open"; // sessionStorage: per-tab expanded state
const HEIGHT_KEY = "lh.terminal.height"; // localStorage: shared cosmetic height
const MIN_H = 120;
const DEFAULT_H = 680; // ~40 rows at the 13px terminal font (capped to the viewport on open)
const BAR_H = 36; // the h-9 toggle bar
const TOP_GAP = 12; // sliver of the app kept visible above a maximized/tall terminal
const RESERVE = BAR_H + TOP_GAP; // viewport px reserved above the terminal content
const MAX_CONTENT = `calc(100dvh - ${RESERVE}px)`;

function readHeight(): number {
  const v = Number(localStorage.getItem(HEIGHT_KEY));
  const base = Number.isFinite(v) && v >= MIN_H ? v : DEFAULT_H;
  // Clamp to the viewport so the height state matches what max-height actually renders — a
  // too-tall default/stored value would otherwise leave a dead zone on the first downward drag.
  return Math.min(base, Math.max(MIN_H, window.innerHeight - RESERVE));
}

export function TerminalPane() {
  // Restore the expanded preference per tab. On a reload the prior PTY is gone, so a tab that was
  // expanded starts a fresh session (started follows expanded at mount); a minimized tab does not.
  const [expanded, setExpanded] = useState(
    () => sessionStorage.getItem(EXPANDED_KEY) === "1",
  );
  const [started, setStarted] = useState(expanded);
  const [maximized, setMaximized] = useState(false);
  const [height, setHeight] = useState(readHeight);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    sessionStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
  }, [expanded]);
  useEffect(() => {
    localStorage.setItem(HEIGHT_KEY, String(height));
  }, [height]);

  const toggle = useCallback(() => {
    setExpanded((v) => {
      const next = !v;
      // Expanding (re)starts a session if none is running; minimizing leaves it running but
      // drops the maximized state so a later peek-open returns to the normal dragged height.
      if (next) setStarted(true);
      else setMaximized(false);
      return next;
    });
  }, []);

  const toggleMaximize = useCallback(() => setMaximized((v) => !v), []);

  // The shell exited (or the connection ended cleanly): tear the session down and collapse.
  const onSessionEnd = useCallback(() => {
    setStarted(false);
    setExpanded(false);
    setMaximized(false);
  }, []);

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
          {/* A session is alive but hidden — mark it so a minimized shell is discoverable. */}
          {started && !expanded && (
            <span
              className="size-1.5 rounded-full bg-emerald-500"
              aria-label="session running"
            />
          )}
        </button>
        {/* Inert spacer: the bar area between the icon and the right controls is not clickable. */}
        <div className="flex-1" />
        {expanded && (
          <button
            type="button"
            onClick={toggleMaximize}
            className="flex size-6 items-center justify-center rounded hover:bg-muted hover:text-foreground"
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
          className="flex size-6 items-center justify-center rounded hover:bg-muted hover:text-foreground"
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
        // Kept mounted once started so minimizing (height 0) doesn't kill the shell. Not keyed by
        // route — the session persists across all navigation until shell exit or reload.
        <div
          style={{ height: contentHeight, maxHeight: MAX_CONTENT }}
          className={`overflow-hidden ${expanded ? "border-t px-2 py-1" : ""}`}
        >
          <TerminalView onExit={onSessionEnd} />
        </div>
      )}
    </div>
  );
}
