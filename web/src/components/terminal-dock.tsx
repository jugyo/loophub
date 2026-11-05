// The bottom dock of the PR and issue screens (#2574): one tab per live agent terminal,
// attached in the browser through lh-web's WebSocket relay (web/server/terminal-relay.ts). Attaching
// happens only for the selected tab, and leaving it closes the socket, which ends the attach but
// never the terminal.

import { ChevronDown, ChevronUp, TerminalSquare } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
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
const DEFAULT_HEIGHT_PX = 320;
const KEYBOARD_RESIZE_STEP_PX = 24;

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  working: "working",
  done: "review-passed",
  blocked: "review-rereview",
  error: "conflict",
};

// The relay refuses anything but loopback, so a remote page shows no terminals at all.
export function isLoopbackPage(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
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
}: {
  repo: string;
  // Absent on the issue screens, whose New issue terminals belong to the repo alone.
  pull?: number;
  terminals: PullTerminal[];
  isError: boolean;
  // A terminal to open the dock on, and to be told once it has.
  requestedAddress?: string | null;
  onRequestHandled?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT_PX);
  const [selected, setSelected] = useState<string | null>(null);
  // A finished terminal drops out of the list, which also ends its view and attach.
  const active = terminals.some((t) => t.address === selected)
    ? selected
    : null;
  const drag = useRef<{ y: number; height: number } | null>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!requestedAddress) return;
    setOpen(true);
    setSelected(requestedAddress);
    onRequestHandled?.();
  }, [requestedAddress, onRequestHandled]);

  // What the dock covers, for the page's floating scroll button to sit above it.
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
      <div className="flex h-9 items-center gap-1 overflow-x-auto px-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setSelected(null);
          }}
        >
          <TerminalSquare className="size-4" aria-hidden="true" />
          Terminals
          {open ? (
            <ChevronDown className="size-4" aria-hidden="true" />
          ) : (
            <ChevronUp className="size-4" aria-hidden="true" />
          )}
        </Button>
        {open ? (
          <div
            role="tablist"
            aria-label="Agent terminals"
            className="flex items-center gap-1"
          >
            {terminals.map((t) => (
              <button
                key={t.address}
                type="button"
                role="tab"
                aria-selected={t.address === active}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-xs hover:bg-accent",
                  t.address === active && "bg-accent font-medium",
                )}
                onClick={() => setSelected(t.address)}
              >
                {t.label}
                <Badge tone={STATUS_TONE[t.status ?? ""] ?? "unknown"}>
                  {t.status ?? "idle"}
                </Badge>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {open ? (
        <div style={{ height }} className="border-t">
          {active ? (
            <TerminalView
              key={active}
              repo={repo}
              pull={pull}
              address={active}
            />
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {isError
                ? "Failed to load terminals."
                : terminals.length === 0
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
}: {
  repo: string;
  pull?: number;
  address: string;
}) {
  const host = useRef<HTMLDivElement>(null);
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
        term.focus();

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
