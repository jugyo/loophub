// The bottom dock of the PR and issue screens (#2574): one tab per live agent terminal,
// attached in the browser through lh-web's WebSocket relay (web/server/terminal-relay.ts). Attaching
// happens only for the selected tab, and leaving it closes the socket, which ends the attach but
// never the terminal.

import {
  ChevronDown,
  ChevronUp,
  History as HistoryIcon,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PullTerminal } from "@/api/types";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MIN_HEIGHT_PX = 120;
const DEFAULT_HEIGHT_PX = 582;
const KEYBOARD_RESIZE_STEP_PX = 24;

// `done` means the agent finished a turn and waits for input; an exited terminal leaves the tabs.
function statusLabel(status: string | null): string {
  return !status || status === "done" ? "idle" : status;
}

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  working: "working",
  blocked: "review-rereview",
  error: "conflict",
};

// The relay refuses anything but loopback, so a remote page shows no terminals at all.
export function isLoopbackPage(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

export interface InactiveTerminalTab {
  key: string;
  label: string;
  // The tab's tooltip.
  title?: string;
  content: ReactNode;
}

function clampHeight(height: number): number {
  return Math.min(Math.max(height, MIN_HEIGHT_PX), window.innerHeight * 0.8);
}

export function TerminalDock({
  repo,
  pull,
  terminals,
  isError,
  requestedAddress = null,
  onRequestHandled,
  selectFirstTab = false,
  onClose,
  history,
  inactive = [],
  actions,
}: {
  repo: string;
  // Absent on the issue screens, whose New issue terminals belong to the repo alone.
  pull?: number;
  terminals: PullTerminal[];
  isError: boolean;
  // The terminal to open the dock on, and the callback to call once the dock has done so.
  requestedAddress?: string | null;
  onRequestHandled?: () => void;
  // Show the leftmost tab whenever no listed tab is selected.
  selectFirstTab?: boolean;
  // Gives each tab a button that ends its terminal.
  onClose?: (terminal: PullTerminal) => void;
  // What a History tab at the right end shows in place of a terminal; no tab without it.
  history?: ReactNode;
  // Tabs for agents whose terminal is gone, after the live ones: selecting one shows its content in
  // place of a terminal.
  inactive?: InactiveTerminalTab[];
  // Controls after the tabs, such as one that adds a terminal.
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(() => clampHeight(DEFAULT_HEIGHT_PX));
  const [selected, setSelected] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const historyShown = open && showHistory && history !== undefined;
  const inactiveShown = historyShown
    ? undefined
    : inactive.find((tab) => tab.key === selected);
  // A finished terminal drops out of the list, which also ends its view and attach.
  const active = terminals.some((t) => t.address === selected)
    ? selected
    : selectFirstTab && !inactiveShown
      ? (terminals[0]?.address ?? null)
      : null;
  // Forget a finished terminal, so it can't take the view back if it is listed again.
  if (
    selectFirstTab &&
    selected !== null &&
    active !== selected &&
    !inactiveShown
  )
    setSelected(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!requestedAddress) return;
    setOpen(true);
    setShowHistory(false);
    setSelected(requestedAddress);
    onRequestHandled?.();
  }, [requestedAddress, onRequestHandled]);

  // What the dock covers, for the floating scroll button and notifications to sit above it.
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty(
      "--pull-terminal-dock-height",
      `${section.current?.offsetHeight ?? 0}px`,
    );
    return () => root.removeProperty("--pull-terminal-dock-height");
  }, [open, height]);

  function onResizeStart(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height };
  }
  function onResizeMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current)
      setHeight(
        clampHeight(drag.current.height + drag.current.y - event.clientY),
      );
  }
  function onResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp")
      setHeight(clampHeight(height + KEYBOARD_RESIZE_STEP_PX));
    if (event.key === "ArrowDown")
      setHeight(clampHeight(height - KEYBOARD_RESIZE_STEP_PX));
  }

  return (
    <section
      ref={section}
      data-debug-component="TerminalDock"
      aria-label="Agent terminals"
      className="sticky bottom-0 z-20 -mx-4 mt-6 border-t bg-card sm:-mx-6"
    >
      {open ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal dock"
          aria-valuenow={Math.round(height)}
          tabIndex={0}
          className="h-1.5 cursor-row-resize touch-none hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={() => {
            drag.current = null;
          }}
          onKeyDown={onResizeKey}
        />
      ) : null}
      <div className="flex h-9 items-center gap-1 px-2">
        <div
          role="tablist"
          aria-label="Agent terminals"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {terminals.map((t, index) => {
            // A minimized dock shows no terminal, so none of its tabs is selected.
            const isSelected = open && !historyShown && t.address === active;
            return (
              <div
                key={t.address}
                className={cn(
                  "flex h-7 shrink-0 items-center rounded-md text-xs hover:bg-accent",
                  isSelected && "bg-accent font-medium",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className="flex h-full items-center gap-2 px-2"
                  onClick={() => {
                    setOpen(true);
                    setShowHistory(false);
                    setSelected(t.address);
                  }}
                >
                  {t.label}
                  <Badge tone={STATUS_TONE[t.status ?? ""] ?? "unknown"}>
                    {statusLabel(t.status)}
                  </Badge>
                </button>
                {onClose ? (
                  <button
                    type="button"
                    aria-label={`Close ${t.label}`}
                    title={`Close ${t.label}`}
                    className="mr-1 grid size-5 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    onClick={() => {
                      // Like a browser tab: closing the shown one moves to its right neighbour,
                      // or its left one at the right end, and takes the keyboard there.
                      if (isSelected)
                        setSelected(
                          (terminals[index + 1] ?? terminals[index - 1])
                            ?.address ?? null,
                        );
                      onClose(t);
                    }}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            );
          })}
          {inactive.map((tab) => {
            const isSelected = open && inactiveShown?.key === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isSelected}
                title={tab.title}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent",
                  isSelected && "bg-accent font-medium",
                )}
                onClick={() => {
                  setOpen(true);
                  setShowHistory(false);
                  setSelected(tab.key);
                }}
              >
                {tab.label}
                <Badge tone="unknown">inactive</Badge>
              </button>
            );
          })}
        </div>
        {actions}
        {history !== undefined ? (
          <button
            type="button"
            aria-pressed={historyShown}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent",
              historyShown && "bg-accent font-medium",
            )}
            onClick={() => {
              setOpen(true);
              setShowHistory(true);
            }}
          >
            <HistoryIcon className="size-3.5" aria-hidden="true" />
            History
          </button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Toggle terminal dock"
          aria-expanded={open}
          title="Toggle terminal dock"
          onClick={() => {
            setOpen(!open);
            setShowHistory(false);
            setSelected(null);
          }}
        >
          {open ? (
            <ChevronDown className="size-4" aria-hidden="true" />
          ) : (
            <ChevronUp className="size-4" aria-hidden="true" />
          )}
        </Button>
      </div>
      {open ? (
        <div style={{ height }} className="border-t">
          {historyShown ? (
            <div className="h-full overflow-y-auto">{history}</div>
          ) : inactiveShown ? (
            <div className="h-full overflow-y-auto">
              {inactiveShown.content}
            </div>
          ) : active ? (
            <TerminalView
              key={active}
              repo={repo}
              pull={pull}
              address={active}
              // Only a person's choice takes the keyboard: a list update must not send what they
              // are typing elsewhere on the page to a running agent.
              focusOnAttach={active === selected}
            />
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {isError
                ? "Failed to load terminals."
                : terminals.length === 0 && inactive.length === 0
                  ? "No live agent terminals."
                  : "Select a terminal to attach."}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function TerminalView({
  repo,
  pull,
  address,
  focusOnAttach,
}: {
  repo: string;
  pull?: number;
  address: string;
  focusOnAttach: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  // As mounted: this tab's later selection must not re-run the attach effect.
  const focusOnMount = useRef(focusOnAttach);
  const [closed, setClosed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cleanup = () => {};
    let disposed = false;
    setClosed(false);
    // Loaded here so a page that never attaches never downloads xterm.js.
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !host.current) return;
        const term = new Terminal({ fontSize: 12, scrollback: 5000 });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host.current);
        fit.fit();

        const query = new URLSearchParams({
          repo,
          ...(pull === undefined ? {} : { pull: String(pull) }),
          terminal: address,
          cols: String(term.cols),
          rows: String(term.rows),
        });
        const scheme = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(
          `${scheme}://${window.location.host}/ws/terminal?${query}`,
        );
        ws.binaryType = "arraybuffer";
        ws.onmessage = (event) => term.write(new Uint8Array(event.data));
        ws.onclose = () => setClosed(true);

        const encoder = new TextEncoder();
        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
        });
        term.onResize(({ cols, rows }) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ cols, rows }));
        });
        const observer = new ResizeObserver(() => fit.fit());
        observer.observe(host.current);
        if (focusOnMount.current || attempt > 0) term.focus();

        cleanup = () => {
          observer.disconnect();
          ws.onclose = null;
          ws.close();
          term.dispose();
        };
      })
      .catch(() => setClosed(true));
    return () => {
      disposed = true;
      cleanup();
    };
  }, [repo, pull, address, attempt]);

  return (
    <div className="flex h-full flex-col bg-black">
      <div ref={host} className="min-h-0 flex-1 p-1" />
      {closed ? (
        <div className="flex items-center gap-2 border-t bg-card px-3 py-1 text-sm text-muted-foreground">
          Connection closed. The terminal itself is not affected.
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setAttempt(attempt + 1)}
          >
            Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );
}
