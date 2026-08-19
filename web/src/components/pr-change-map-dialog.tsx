import { Maximize2, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { PrChangeMap, PullFile } from "@/api/types";
import { DiffLines } from "@/components/diff-lines";
import { DiffStat } from "@/components/diff-stat";
import { FileStatusBadge } from "@/components/file-status-badge";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/time";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { cn } from "@/lib/utils";
import type { ChangeMapChange } from "../../../core/change-map-document.ts";
import { changeMapDocumentPaths } from "../../../core/change-map-document.ts";

// #344: the change map, read top-down. Four columns, each one level of the map — category, change,
// file, diff — where picking an item fills the column to its right. The reader takes in the shape
// of the change from the left and descends only into what they became interested in, instead of
// reassembling it from the diffs.
//
// Whatever the map does not mention is offered as one more category, Not covered, so it is reached
// exactly like everything else. That is what makes "no diff is unreachable from the map" hold
// regardless of the map's quality: a map with holes still routes to every file, and a complete map
// simply has no such category. Nothing here rewrites or blocks the map — it only shows what it
// left out.

const NOT_COVERED = "__not_covered__";

// #350: the Miller columns are read, not just clicked through, so their labels wrap instead of
// being cut off — and the widths that were `w-56` / `w-64` / `w-80` are now the starting point of
// something the reader can drag. Kept in component state on purpose: a width chosen for one map is
// rarely the right one for the next, so reopening the dialog starts from the defaults again.
const DEFAULT_COLUMN_WIDTHS = { category: 224, change: 256, file: 320 };
type ColumnKey = keyof typeof DEFAULT_COLUMN_WIDTHS;

/** How narrow a dragged column may get before it stops following the pointer. */
const MIN_COLUMN_WIDTH = 160;

/** A first-column entry: one of the document's categories, or the synthesized Not covered one. */
interface MapCategory {
  key: string;
  name: string;
  summary: string;
  changes: ChangeMapChange[];
  covered: boolean;
}

export function PrChangeMapDialog({
  changeMap,
  files,
  headSha,
  onOpenFile,
  onClose,
}: {
  changeMap: PrChangeMap;
  /** The PR's changed files, or undefined while they are still loading. */
  files: PullFile[] | undefined;
  /** The PR's live head, for the stale badge. */
  headSha: string | null;
  onOpenFile: (filename: string) => void;
  onClose: () => void;
}) {
  const backdropDismiss = useBackdropDismiss(onClose);
  const [at, setAt] = useState({ category: 0, change: 0, file: 0 });
  const [widths, setWidths] = useState(DEFAULT_COLUMN_WIDTHS);
  const resizeColumn = useCallback((key: ColumnKey, width: number) => {
    setWidths((current) => ({
      ...current,
      [key]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)),
    }));
  }, []);

  const categories = useMemo<MapCategory[]>(() => {
    const document = changeMap.document;
    const items: MapCategory[] = document.categories.map((category, index) => ({
      key: `c${index}`,
      name: category.name,
      summary: category.summary,
      changes: category.changes,
      covered: true,
    }));
    if (!files) return items;
    const declared = changeMapDocumentPaths(document);
    const missing = files.filter((file) => !declared.has(file.filename));
    if (missing.length === 0) return items;
    // Modelled as an ordinary category so the descent stays uniform: the columns need no special
    // case, and a file the map forgot is opened the same way as one it named.
    items.push({
      key: NOT_COVERED,
      name: `Not covered (${missing.length})`,
      summary: "Changed files the map does not mention.",
      changes: [
        {
          name: `${missing.length} ${missing.length === 1 ? "file" : "files"}`,
          kind: "unmapped",
          summary:
            "Reachable from here, but nothing in the map accounts for them.",
          files: missing.map((file) => ({ path: file.filename })),
        },
      ],
      covered: false,
    });
    return items;
  }, [changeMap.document, files]);

  const category = categories[Math.min(at.category, categories.length - 1)];
  const change =
    category?.changes[Math.min(at.change, category.changes.length - 1)];
  const entry = change?.files[Math.min(at.file, change.files.length - 1)];
  const filename = entry?.path;
  // A path the map declares need not be in the PR — the head can move under a saved map — so the
  // last column only offers a diff when there is one.
  const file = filename
    ? files?.find((candidate) => candidate.filename === filename)
    : undefined;
  const isStale = !!headSha && headSha !== changeMap.head_sha;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/80 p-2 backdrop-blur-sm sm:p-4"
      {...backdropDismiss}
    >
      <div
        data-debug-component="PrChangeMapDialog"
        role="dialog"
        aria-modal="true"
        aria-label="Change map"
        className="flex max-h-full w-full flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      >
        <header className="flex items-start justify-between gap-3 border-b px-5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="text-base font-semibold">Change map</h2>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {changeMap.head_sha.slice(0, 7)} ·{" "}
                {relativeTime(changeMap.created_at)}
              </span>
              {isStale ? (
                <span
                  className="whitespace-nowrap rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"
                  title={`Written against ${changeMap.head_sha.slice(0, 7)}; the PR head is now ${headSha?.slice(0, 7)}. Commits added since are not in this map.`}
                >
                  Stale
                </span>
              ) : null}
            </div>
            <Prose className="text-sm text-muted-foreground">
              {changeMap.document.summary}
            </Prose>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1">
          <ColumnPane
            label="Category"
            count={categories.length}
            width={widths.category}
          >
            {categories.map((item, index) => (
              <ColumnRow
                key={item.key}
                selected={item === category}
                onSelect={() => setAt({ category: index, change: 0, file: 0 })}
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    !item.covered && "italic",
                  )}
                  title={item.summary}
                >
                  {item.name}
                </span>
              </ColumnRow>
            ))}
          </ColumnPane>
          <ColumnResizer
            label="Category"
            width={widths.category}
            onResize={(width) => resizeColumn("category", width)}
          />

          <ColumnPane
            label="Change"
            count={category?.changes.length ?? 0}
            width={widths.change}
          >
            {(category?.changes ?? []).map((item, index) => (
              <ColumnRow
                key={`${category.key}:${index}:${item.name}`}
                selected={item === change}
                onSelect={() =>
                  setAt((current) => ({ ...current, change: index, file: 0 }))
                }
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="break-words">{item.name}</span>
                  <span className="break-words text-xs text-muted-foreground">
                    {item.kind}
                  </span>
                </span>
              </ColumnRow>
            ))}
          </ColumnPane>
          <ColumnResizer
            label="Change"
            width={widths.change}
            onResize={(width) => resizeColumn("change", width)}
          />

          <div
            className="flex shrink-0 flex-col border-r"
            style={{ width: widths.file }}
          >
            <ColumnHeader label="File" count={change?.files.length ?? 0} />
            {change ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* The prose belongs to the change, so it is read exactly where the change is
                    selected — a note nobody can navigate to is the same defect as an unreachable
                    diff. All of it reads as commentary on the files, the way a review comment reads
                    as commentary on code, so it follows the list rather than pushing it down. */}
                <ul className="divide-y">
                  {change.files.map((candidate, index) => {
                    const listed = files?.find(
                      (f) => f.filename === candidate.path,
                    );
                    return (
                      <li key={candidate.path}>
                        <button
                          type="button"
                          aria-current={candidate.path === filename}
                          disabled={!!files && !listed}
                          title={
                            files && !listed
                              ? `${candidate.path} is named by the map but is not in this PR's diff`
                              : candidate.path
                          }
                          onClick={() =>
                            setAt((current) => ({ ...current, file: index }))
                          }
                          className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-3 py-1.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 aria-[current=true]:bg-accent"
                        >
                          {listed ? (
                            <FileStatusBadge status={listed.status} />
                          ) : (
                            <span aria-hidden="true" className="size-4" />
                          )}
                          <span className="min-w-0 break-all font-mono text-xs">
                            {candidate.path}
                          </span>
                          {listed ? (
                            <DiffStat
                              additions={listed.additions}
                              deletions={listed.deletions}
                              className="justify-self-end text-xs"
                            />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-col gap-2 border-t bg-muted/20 px-3 py-2.5 text-xs">
                  <Prose className="text-foreground">{change.summary}</Prose>
                  {change.tests ? (
                    <div className="text-muted-foreground">
                      <span className="font-medium text-foreground">Tests</span>
                      <Prose>{change.tests}</Prose>
                    </div>
                  ) : null}
                  {change.risk ? (
                    <div className="text-muted-foreground">
                      <span className="font-medium text-foreground">Risk</span>
                      <Prose>{change.risk}</Prose>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <ColumnResizer
            label="File"
            width={widths.file}
            onResize={(width) => resizeColumn("file", width)}
          />

          {/* The descent ends in the diff itself, not in a link to it: the last column is the
              reason the reader came, so making them click again to see it would put the thing they
              were navigating towards one step beyond the navigation. The full dialog stays one
              click away for what this view deliberately does not carry — split view, whitespace,
              rendered Markdown, and line comments. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span className="min-w-0 truncate">{filename ?? "Diff"}</span>
              {file ? (
                <div className="flex shrink-0 items-center gap-2">
                  <DiffStat
                    additions={file.additions}
                    deletions={file.deletions}
                    className="text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs normal-case"
                    onClick={() => onOpenFile(file.filename)}
                    title="Open this file in the full diff view"
                  >
                    <Maximize2 className="size-3" />
                    Full view
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {/* What this change did to this one file, when the map bothered to say. It sits above
                  the diff because it is what the diff is there to show. */}
              {file && entry?.summary ? (
                <div className="border-b bg-muted/20 px-3 py-2 text-xs">
                  <Prose className="text-foreground">{entry.summary}</Prose>
                </div>
              ) : null}
              {file ? (
                <DiffLines patch={file.patch} />
              ) : (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                  {filename
                    ? "This file is named by the map but is not in this PR's diff."
                    : "Pick a file to see its diff."}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The document's prose is written by an LLM, which reaches for Markdown without being asked —
// backticked paths, emphasis, lists, and the occasional ```mermaid fence. Rendering it through the
// shared renderer is what keeps those from showing up as literal punctuation, and it is the same
// path (including Mermaid) every other body on the page goes through.
function Prose({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <Markdown className={cn("markdown-compact", className)}>
      {children}
    </Markdown>
  );
}

function ColumnHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <span className="min-w-0 truncate">{label}</span>
      {count == null ? null : <span>{count}</span>}
    </div>
  );
}

function ColumnPane({
  label,
  count,
  width,
  children,
}: {
  label: string;
  count: number;
  /** Current width in pixels — see DEFAULT_COLUMN_WIDTHS. */
  width: number;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-col border-r" style={{ width }}>
      <ColumnHeader label={label} count={count} />
      <ul className="min-h-0 flex-1 divide-y overflow-y-auto">{children}</ul>
    </div>
  );
}

function ColumnRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        onClick={onSelect}
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=true]:bg-accent"
      >
        {children}
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-muted-foreground"
        >
          ›
        </span>
      </button>
    </li>
  );
}

// The handle on a column's right edge. Dragging is tracked on the window rather than on the handle
// so the pointer may leave the 4px strip mid-drag without the column stopping halfway.
function ColumnResizer({
  label,
  width,
  onResize,
}: {
  label: string;
  width: number;
  onResize: (width: number) => void;
}) {
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null);

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) =>
      onResize(drag.width + event.clientX - drag.x);
    const stop = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [drag, onResize]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      onPointerDown={(event) => {
        event.preventDefault();
        setDrag({ x: event.clientX, width });
      }}
      className={cn(
        "w-1 shrink-0 cursor-col-resize hover:bg-primary/40",
        drag && "bg-primary/40",
      )}
    />
  );
}
