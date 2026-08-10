// Debug panel (--debug only): a small toggle button hosted in the bottom status bar
// (AppStatusbar) that opens a full-width dock panel (Chrome DevTools style) showing the
// event -> invalidation -> refetch trail recorded in web/src/lib/debug-log.ts. Its top
// edge can be dragged to resize the height, and its log view follows the tail while the
// scroll position stays at the bottom. Desktop-only; the panel is a fixed overlay and
// does not participate in mobile layout.

import { Activity, Bug, Cable, ListTree, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  clearDebugLog,
  type DebugLogState,
  type EventLogEntry,
  type InvalidationLogEntry,
  type RpcLogEntry,
  useDebugLog,
} from "@/lib/debug-log";
import { cn } from "@/lib/utils";
import { useWebConfig } from "@/lib/web-config";

type LogTab = "events" | "invalidations" | "rpcs";

const TABS: { id: LogTab; label: string }[] = [
  { id: "events", label: "Events" },
  { id: "invalidations", label: "Invalidation" },
  { id: "rpcs", label: "RPC" },
];

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 96;
// Cap the dock at 90% of the viewport so a slice of the app stays visible above it.
const MAX_HEIGHT_FRACTION = 0.9;
// While the scroll position is this close to the bottom, follow the tail.
const STICK_TO_BOTTOM_EPSILON = 8;

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatParams(params: Record<string, unknown>): string {
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}

function EventRow({ entry }: { entry: EventLogEntry }) {
  return (
    <li className="border-b px-3 py-1.5 font-mono text-[11px] leading-relaxed">
      <span className="text-muted-foreground">{formatTime(entry.at)}</span>{" "}
      <span className="text-foreground">#{entry.eventId}</span>{" "}
      <span className="text-foreground">{entry.type}</span>
      {entry.repo ? (
        <span className="text-muted-foreground"> ({entry.repo})</span>
      ) : null}
    </li>
  );
}

function InvalidationRow({ entry }: { entry: InvalidationLogEntry }) {
  return (
    <li className="border-b px-3 py-1.5">
      <div className="font-mono text-[11px] leading-relaxed">
        <span className="text-muted-foreground">{formatTime(entry.at)}</span>{" "}
        <span className="text-foreground">
          #{entry.eventId} {entry.eventType}
        </span>
      </div>
      <ul className="mt-0.5 space-y-0.5">
        {entry.keys.map((key, index) => (
          <li
            key={index}
            className="truncate pl-3 font-mono text-[10px] text-muted-foreground"
            title={JSON.stringify(key)}
          >
            {JSON.stringify(key)}
          </li>
        ))}
      </ul>
    </li>
  );
}

function RpcRow({ entry }: { entry: RpcLogEntry }) {
  return (
    <li className="border-b px-3 py-1.5">
      <div className="flex items-baseline gap-1.5 font-mono text-[11px] leading-relaxed">
        <span className="shrink-0 text-muted-foreground">
          {formatTime(entry.at)}
        </span>
        <span
          className={cn(
            "min-w-0 truncate",
            entry.ok ? "text-foreground" : "text-destructive",
          )}
          title={entry.method}
        >
          {entry.method}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0",
            entry.durationMs >= 500
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {entry.durationMs.toFixed(1)}ms
        </span>
      </div>
      <div
        className="truncate pl-[4.5rem] font-mono text-[10px] text-muted-foreground"
        title={formatParams(entry.params)}
      >
        {formatParams(entry.params)}
      </div>
      {entry.error ? (
        <div
          className="truncate pl-[4.5rem] font-mono text-[10px] text-destructive"
          title={entry.error}
        >
          {entry.error}
        </div>
      ) : null}
    </li>
  );
}

function LogList({ tab, logs }: { tab: LogTab; logs: DebugLogState }) {
  const emptyMessage =
    tab === "events"
      ? "No events received yet"
      : tab === "invalidations"
        ? "No invalidations yet"
        : "No RPC calls yet";
  const entries =
    tab === "events"
      ? logs.events
      : tab === "invalidations"
        ? logs.invalidations
        : logs.rpcs;

  if (entries.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">{emptyMessage}</p>
    );
  }

  return (
    <ul>
      {entries.map((entry) =>
        tab === "events" ? (
          <EventRow key={entry.seq} entry={entry as EventLogEntry} />
        ) : tab === "invalidations" ? (
          <InvalidationRow
            key={entry.seq}
            entry={entry as InvalidationLogEntry}
          />
        ) : (
          <RpcRow key={entry.seq} entry={entry as RpcLogEntry} />
        ),
      )}
    </ul>
  );
}

export function DebugPanel() {
  const { debug } = useWebConfig();
  const [open, setOpen] = useState(false);
  const logs = useDebugLog(debug && open);

  if (!debug) return null;

  function handleClose() {
    clearDebugLog();
    setOpen(false);
  }

  return (
    <>
      {open ? <DebugLogPanel logs={logs} onClose={handleClose} /> : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Debug panel"
        aria-pressed={open}
        title="Debug panel"
        onClick={() => setOpen(true)}
        className="ml-1 h-7 w-7"
      >
        <Bug className="size-3.5" aria-hidden="true" />
      </Button>
    </>
  );
}

function DebugLogPanel({
  logs,
  onClose,
}: {
  logs: DebugLogState;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<LogTab>("events");
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [resizing, setResizing] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const entries =
    tab === "events"
      ? logs.events
      : tab === "invalidations"
        ? logs.invalidations
        : logs.rpcs;

  // While pinned to the tail, keep the newest entry in view when the list grows.
  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - el.clientHeight;
  }, [entries, stickToBottom]);

  // Drag on the panel's top edge to resize its height (Chrome DevTools style).
  useEffect(() => {
    if (!resizing) return;
    function onPointerMove(event: PointerEvent) {
      setHeight(
        Math.max(
          MIN_HEIGHT,
          Math.min(
            window.innerHeight * MAX_HEIGHT_FRACTION,
            window.innerHeight - event.clientY,
          ),
        ),
      );
    }
    function onPointerUp() {
      setResizing(false);
    }
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [resizing]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom < STICK_TO_BOTTOM_EPSILON);
  }

  return (
    <div
      data-testid="debug-log-panel"
      className="fixed inset-x-0 bottom-7 z-50 flex flex-col overflow-hidden border-t bg-card shadow-lg"
      style={{ height }}
    >
      <div
        role="separator"
        aria-label="Resize debug panel"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={Math.round(window.innerHeight * MAX_HEIGHT_FRACTION)}
        aria-valuenow={Math.round(height)}
        className={cn(
          "h-2 shrink-0 cursor-row-resize touch-none border-b bg-border/40",
          resizing && "bg-primary/30",
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          setResizing(true);
        }}
      />
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">Debug panel</h2>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Clear debug logs"
            onClick={clearDebugLog}
            className="h-7 px-2 text-xs"
          >
            Clear
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close debug panel"
            title="Close debug panel"
            onClick={onClose}
            className="h-7 w-7"
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div
        role="tablist"
        aria-label="Debug log categories"
        className="flex h-9 items-end gap-1 border-b px-2"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              tab === id
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => {
              setTab(id);
              setStickToBottom(true);
            }}
          >
            {id === "events" ? (
              <Activity className="size-3" aria-hidden="true" />
            ) : id === "invalidations" ? (
              <ListTree className="size-3" aria-hidden="true" />
            ) : (
              <Cable className="size-3" aria-hidden="true" />
            )}
            {label}
          </button>
        ))}
      </div>
      <div
        ref={scrollRef}
        data-testid="debug-log-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        <LogList tab={tab} logs={logs} />
      </div>
    </div>
  );
}
