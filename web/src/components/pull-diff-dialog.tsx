// PR-detail diff dialog: the full-size modal opened from a file summary row, showing one file's
// diff with line comments plus Raw and (for Markdown) Base/Head rendered previews. The dialog owns
// its own Escape handling, mode switching, per-mode file fetch, and the copy-path resolution for
// renamed / invisible-character filenames. The Files changed section only picks the open file and
// drives prev/next navigation through props.

import { ChevronLeft, ChevronRight, Filter, Loader2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PullFile, PullLineComment } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { DiffStat } from "@/components/diff-stat";
import { FileStatusBadge } from "@/components/file-status-badge";
import { Markdown } from "@/components/markdown";
import { Button, disabledButtonStateClasses } from "@/components/ui/button";
import {
  type DiffLineKind,
  type PositionedDiffLine,
  parsePositionedPatch,
} from "@/lib/diff";
import { cn } from "@/lib/utils";
import { usePullFileAtRef } from "@/queries/pulls";

// Markdown files can also switch the same diff dialog to base/head rendered previews.
const MARKDOWN_FILENAME = /\.(md|markdown)$/i;

// `file.filename` for a rename is git numstat's display label ("old => new" / "dir/{old =>
// new}"), not a real path. The copy button can use `headFilename`, but the Markdown Preview
// path still points at `file.filename`, so keep previews off for synthetic rename labels.
const RENAMED_FILENAME = / => /;

function isSyntheticRenameFilename(file: PullFile) {
  return (
    file.status === "renamed" ||
    (RENAMED_FILENAME.test(file.filename) && !file.patch?.trim())
  );
}

function renameTargetPath(filename: string) {
  const braced = /^(.*)\{(.+) => (.+)\}(.*)$/.exec(filename);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`;
  const direct = /^.+ => (.+)$/.exec(filename);
  return direct?.[1] ?? null;
}

function copyFilename(file: PullFile) {
  if (file.headFilename) return file.headFilename;
  if (isSyntheticRenameFilename(file)) {
    return renameTargetPath(file.filename) ?? file.filename;
  }
  return file.filename;
}

const UNSAFE_COPY_PATH_CHAR = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/u;

function visibleCopyPath(path: string) {
  if (!UNSAFE_COPY_PATH_CHAR.test(path)) return path;
  return Array.from(path, (char) => {
    if (!UNSAFE_COPY_PATH_CHAR.test(char)) return char;
    switch (char) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default: {
        const codePoint = char.codePointAt(0) ?? 0;
        return codePoint > 0xffff
          ? `\\u{${codePoint.toString(16)}}`
          : `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
    }
  }).join("");
}

type DiffDialogMode = "diff" | "raw" | "base" | "head";
type StandardDiffDialogMode = "diff" | "raw";
type DiffViewMode = "unified" | "split";
type SplitRow =
  | {
      kind: "line";
      left: PositionedDiffLine | null;
      right: PositionedDiffLine | null;
      leftMarkers?: PositionedDiffLine[];
      rightMarkers?: PositionedDiffLine[];
    }
  | { kind: "separator"; line: PositionedDiffLine };

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-green-500/10 text-green-700 dark:text-green-300",
  del: "bg-red-500/10 text-red-700 dark:text-red-300",
  hunk: "bg-muted text-muted-foreground",
  meta: "text-muted-foreground",
  context: "",
};

const DIFF_LINE_MARKER: Record<DiffLineKind, string> = {
  add: "+",
  del: "-",
  hunk: "",
  meta: "",
  context: " ",
};

const INITIAL_FILE_SIDEBAR_WIDTH = 336;
const MIN_FILE_SIDEBAR_WIDTH = 160;
const MAX_FILE_SIDEBAR_WIDTH = 480;

function globPatternToRegExp(pattern: string) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesGlobList(filename: string, value: string) {
  const patterns = value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  return patterns.some((pattern) =>
    globPatternToRegExp(pattern).test(filename),
  );
}

export function DiffFileDialog({
  owner,
  repo,
  number,
  files,
  file,
  comments,
  hasPreviousFile,
  hasNextFile,
  onPreviousFile,
  onNextFile,
  onSelectFile,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  files: PullFile[];
  file: PullFile;
  comments: PullLineComment[];
  hasPreviousFile: boolean;
  hasNextFile: boolean;
  onPreviousFile: () => void;
  onNextFile: () => void;
  onSelectFile: (filename: string) => void;
  onClose: () => void;
}) {
  const [standardMode, setStandardMode] =
    useState<StandardDiffDialogMode>("diff");
  const [markdownMode, setMarkdownMode] = useState<DiffDialogMode>("diff");
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("split");
  const [showFileFilters, setShowFileFilters] = useState(false);
  const [includePattern, setIncludePattern] = useState("");
  const [excludePattern, setExcludePattern] = useState("");
  const [fileSidebarWidth, setFileSidebarWidth] = useState(
    INITIAL_FILE_SIDEBAR_WIDTH,
  );
  const [sidebarDrag, setSidebarDrag] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const mouseDownStartedOnBackdrop = useRef(false);
  const copyPath = visibleCopyPath(copyFilename(file));
  const isMarkdown =
    MARKDOWN_FILENAME.test(file.filename) && !isSyntheticRenameFilename(file);
  const mode = isMarkdown ? markdownMode : standardMode;
  const filteredFiles = useMemo(
    () =>
      files.filter(
        (candidate) =>
          (!includePattern.trim() ||
            matchesGlobList(candidate.filename, includePattern)) &&
          (!excludePattern.trim() ||
            !matchesGlobList(candidate.filename, excludePattern)),
      ),
    [excludePattern, files, includePattern],
  );

  function selectMode(nextMode: DiffDialogMode) {
    if (nextMode === "base" || nextMode === "head") {
      setMarkdownMode(nextMode);
      return;
    }
    setStandardMode(nextMode);
    if (isMarkdown) setMarkdownMode(nextMode);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!sidebarDrag) return;
    const drag = sidebarDrag;
    function onPointerMove(event: PointerEvent) {
      setFileSidebarWidth(
        Math.min(
          MAX_FILE_SIDEBAR_WIDTH,
          Math.max(
            MIN_FILE_SIDEBAR_WIDTH,
            drag.startWidth + event.clientX - drag.startX,
          ),
        ),
      );
    }
    function onPointerUp() {
      setSidebarDrag(null);
    }
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, [sidebarDrag]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/80 p-2 backdrop-blur-sm sm:p-4"
      onMouseDown={(event) => {
        mouseDownStartedOnBackdrop.current =
          event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const endsOnBackdrop = event.target === event.currentTarget;
        if (mouseDownStartedOnBackdrop.current && endsOnBackdrop) onClose();
        mouseDownStartedOnBackdrop.current = false;
      }}
    >
      <div
        data-debug-component="DiffFileDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Diff for ${file.filename}`}
        className="flex max-h-full w-full overflow-hidden rounded-md border bg-background shadow-lg"
      >
        <aside
          aria-label="Changed files"
          className="shrink-0 overflow-y-auto bg-muted/20"
          style={{ width: fileSidebarWidth }}
        >
          <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs font-semibold">
              <span>
                Files changed ({filteredFiles.length}
                {filteredFiles.length !== files.length
                  ? ` of ${files.length}`
                  : ""}
                )
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Toggle file filters"
                aria-expanded={showFileFilters}
                className={cn(
                  "size-6",
                  (includePattern || excludePattern) && "text-primary",
                )}
                onClick={() => setShowFileFilters((visible) => !visible)}
              >
                <Filter className="size-3.5" />
              </Button>
            </div>
            {showFileFilters ? (
              <div className="grid gap-2 border-t px-3 py-2">
                <label className="grid gap-1 text-[10px] font-medium text-muted-foreground">
                  Include
                  <input
                    type="text"
                    aria-label="Include files"
                    placeholder="e.g. web/**, *.md"
                    value={includePattern}
                    onChange={(event) => setIncludePattern(event.target.value)}
                    className="h-7 rounded-md border bg-background px-2 font-mono text-xs font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="grid gap-1 text-[10px] font-medium text-muted-foreground">
                  Exclude
                  <input
                    type="text"
                    aria-label="Exclude files"
                    placeholder="e.g. **/*.test.ts"
                    value={excludePattern}
                    onChange={(event) => setExcludePattern(event.target.value)}
                    className="h-7 rounded-md border bg-background px-2 font-mono text-xs font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </div>
            ) : null}
          </div>
          <ul className="py-1">
            {filteredFiles.map((sidebarFile) => {
              const selected = sidebarFile.filename === file.filename;
              return (
                <li key={sidebarFile.filename}>
                  <button
                    type="button"
                    aria-label={sidebarFile.filename}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "grid w-full gap-1 px-3 py-1.5 text-left hover:bg-muted",
                      selected &&
                        "bg-accent font-medium text-accent-foreground",
                    )}
                    onClick={() => onSelectFile(sidebarFile.filename)}
                  >
                    <span className="break-all font-mono text-xs">
                      {sidebarFile.filename}
                    </span>
                    <span className="flex items-center gap-2">
                      <FileStatusBadge status={sidebarFile.status} />
                      <DiffStat
                        additions={sidebarFile.additions}
                        deletions={sidebarFile.deletions}
                        className="text-[11px]"
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <div
          role="separator"
          aria-label="Resize changed files sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_FILE_SIDEBAR_WIDTH}
          aria-valuemax={MAX_FILE_SIDEBAR_WIDTH}
          aria-valuenow={fileSidebarWidth}
          className={cn(
            "relative w-1 shrink-0 cursor-col-resize touch-none border-x bg-border/40",
            sidebarDrag && "bg-primary/30",
          )}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            setSidebarDrag({
              startX: event.clientX,
              startWidth: fileSidebarWidth,
            });
          }}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1">
                <h3 className="min-w-0 truncate text-sm font-semibold">
                  {file.filename}
                </h3>
                <CopyButton
                  key={copyPath}
                  value={copyPath}
                  label={`Copy file path: ${copyPath}`}
                  className="size-6"
                />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <FileStatusBadge status={file.status} />
                <DiffStat
                  additions={file.additions}
                  deletions={file.deletions}
                />
              </div>
            </div>
            <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
              <div className="flex overflow-hidden rounded-md border text-xs">
                <ModeButton
                  active={mode === "diff"}
                  onClick={() => selectMode("diff")}
                >
                  Diff
                </ModeButton>
                <ModeButton
                  active={mode === "raw"}
                  onClick={() => selectMode("raw")}
                >
                  Raw
                </ModeButton>
                {isMarkdown ? (
                  <>
                    <ModeButton
                      active={mode === "base"}
                      onClick={() => selectMode("base")}
                    >
                      Base
                    </ModeButton>
                    <ModeButton
                      active={mode === "head"}
                      onClick={() => selectMode("head")}
                    >
                      Head
                    </ModeButton>
                  </>
                ) : null}
              </div>
              {mode === "diff" ? (
                <div
                  className="flex overflow-hidden rounded-md border text-xs"
                  aria-label="Diff view"
                >
                  <ModeButton
                    active={diffViewMode === "unified"}
                    onClick={() => setDiffViewMode("unified")}
                  >
                    Unified
                  </ModeButton>
                  <ModeButton
                    active={diffViewMode === "split"}
                    onClick={() => setDiffViewMode("split")}
                  >
                    Split
                  </ModeButton>
                </div>
              ) : null}
              <div className="flex overflow-hidden rounded-md border text-xs">
                <ModeButton
                  disabled={!hasPreviousFile}
                  onClick={onPreviousFile}
                >
                  <ChevronLeft className="size-3" />
                  Prev
                </ModeButton>
                <ModeButton disabled={!hasNextFile} onClick={onNextFile}>
                  Next
                  <ChevronRight className="size-3" />
                </ModeButton>
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-label="Close diff"
                className="h-7 w-7 shrink-0 p-0"
                onClick={onClose}
              >
                <X className="size-4" />
              </Button>
            </div>
          </header>
          <div className="min-w-0 flex-1 overflow-auto">
            <FileDiffContent
              owner={owner}
              repo={repo}
              number={number}
              file={file}
              comments={comments}
              mode={mode}
              diffViewMode={diffViewMode}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  disabled = false,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active ?? undefined}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1 px-2.5 py-1 transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        disabled && disabledButtonStateClasses,
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FileDiffContent({
  owner,
  repo,
  number,
  file,
  comments,
  mode,
  diffViewMode,
}: {
  owner: string;
  repo: string;
  number: number;
  file: PullFile;
  comments: PullLineComment[];
  mode: DiffDialogMode;
  diffViewMode: DiffViewMode;
}) {
  if (mode === "raw") {
    return (
      <RawFilePane
        owner={owner}
        repo={repo}
        number={number}
        path={copyFilename(file)}
        side={file.status === "removed" ? "base" : "head"}
      />
    );
  }
  if (mode === "base" || mode === "head") {
    return (
      <MarkdownPreviewPane
        owner={owner}
        repo={repo}
        number={number}
        path={file.filename}
        side={mode}
      />
    );
  }

  return (
    <div data-debug-component="FileDiffContent">
      <DialogDiff patch={file.patch} viewMode={diffViewMode} />
      {comments.map((c) => (
        <div key={c.id} className="m-2 rounded-md border bg-muted/20 p-2">
          <div className="mb-1 text-xs">
            💬 @{c.user.login}{" "}
            <span className="text-muted-foreground">
              {c.path}:{c.line ?? "?"}
            </span>
          </div>
          <Markdown owner={owner} repo={repo}>
            {c.body}
          </Markdown>
        </div>
      ))}
    </div>
  );
}

function DialogDiff({
  patch,
  viewMode,
}: {
  patch: string | undefined | null;
  viewMode: DiffViewMode;
}) {
  const lines = parsePositionedPatch(patch);
  if (lines.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No textual diff.
      </p>
    );
  }
  return viewMode === "unified" ? (
    <UnifiedDiff lines={lines} />
  ) : (
    <SplitDiff lines={lines} />
  );
}

function UnifiedDiff({ lines }: { lines: PositionedDiffLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs leading-5">
        <tbody>
          {lines.map((line, index) => (
            <tr
              key={`${line.oldLine}:${line.newLine}:${index}`}
              className={DIFF_LINE_CLASS[line.kind]}
              data-line-kind={line.kind}
            >
              <LineNumber line={line.oldLine} label="Old" />
              <LineNumber line={line.newLine} label="New" />
              <td className="whitespace-pre pr-4">
                <span
                  aria-hidden="true"
                  className="inline-block w-5 select-none text-center"
                >
                  {DIFF_LINE_MARKER[line.kind]}
                </span>
                {lineContent(line) || " "}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SplitDiff({ lines }: { lines: PositionedDiffLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
        <colgroup>
          <col className="w-12" />
          <col style={{ width: "calc(50% - 3rem)" }} />
          <col className="w-12" />
          <col style={{ width: "calc(50% - 3rem)" }} />
        </colgroup>
        <tbody>
          {splitRows(lines).map((row, index) =>
            row.kind === "separator" ? (
              <tr
                key={`separator:${index}`}
                className={DIFF_LINE_CLASS[row.line.kind]}
                data-line-kind={row.line.kind}
              >
                <td colSpan={4} className="whitespace-pre px-3">
                  {row.line.text || " "}
                </td>
              </tr>
            ) : (
              <tr key={`line:${index}`}>
                <SplitLine
                  line={row.left}
                  markers={row.leftMarkers}
                  side="old"
                />
                <SplitLine
                  line={row.right}
                  markers={row.rightMarkers}
                  side="new"
                />
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function LineNumber({
  line,
  label,
}: {
  line: number | null;
  label: "Old" | "New";
}) {
  return (
    <td
      aria-label={line === null ? undefined : `${label} line ${line}`}
      className="w-12 select-none border-r px-2 text-right text-muted-foreground/70"
    >
      {line}
    </td>
  );
}

function SplitLine({
  line,
  markers = [],
  side,
}: {
  line: PositionedDiffLine | null;
  markers?: PositionedDiffLine[];
  side: "old" | "new";
}) {
  const lineNumber = line
    ? side === "old"
      ? line.oldLine
      : line.newLine
    : null;
  return (
    <>
      <td
        aria-label={
          lineNumber === null
            ? undefined
            : `${side === "old" ? "Old" : "New"} line ${lineNumber}`
        }
        className={cn(
          "w-12 select-none border-r px-2 text-right text-muted-foreground/70",
          line && DIFF_LINE_CLASS[line.kind],
          side === "new" && "border-l",
        )}
      >
        {lineNumber}
      </td>
      <td
        className={cn("min-w-0", line && DIFF_LINE_CLASS[line.kind])}
        data-line-kind={line?.kind}
      >
        {line ? (
          <div className="whitespace-pre-wrap break-words pr-4">
            <span
              aria-hidden="true"
              className="inline-block w-5 select-none text-center"
            >
              {DIFF_LINE_MARKER[line.kind]}
            </span>
            {lineContent(line) || " "}
            {markers.map((marker, index) => (
              <span
                key={`${marker.text}:${index}`}
                className="block pl-5 text-muted-foreground"
              >
                {marker.text}
              </span>
            ))}
          </div>
        ) : null}
      </td>
    </>
  );
}

function splitRows(lines: PositionedDiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "hunk" || line.kind === "meta") {
      rows.push({ kind: "separator", line });
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ kind: "line", left: line, right: line });
      index += 1;
      continue;
    }

    const deletions: PositionedDiffLine[] = [];
    const additions: PositionedDiffLine[] = [];
    const deletionMarkers = new Map<number, PositionedDiffLine[]>();
    const additionMarkers = new Map<number, PositionedDiffLine[]>();
    let activeSide: "deletion" | "addition" | null = null;
    while (index < lines.length) {
      const changedLine = lines[index];
      if (changedLine.kind === "del") {
        deletions.push(changedLine);
        activeSide = "deletion";
      } else if (changedLine.kind === "add") {
        additions.push(changedLine);
        activeSide = "addition";
      } else if (isNoNewlineMarker(changedLine) && activeSide !== null) {
        const markers =
          activeSide === "deletion" ? deletionMarkers : additionMarkers;
        const lineIndex =
          activeSide === "deletion"
            ? deletions.length - 1
            : additions.length - 1;
        markers.set(lineIndex, [
          ...(markers.get(lineIndex) ?? []),
          changedLine,
        ]);
      } else {
        break;
      }
      index += 1;
    }

    const rowCount = Math.max(deletions.length, additions.length);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      rows.push({
        kind: "line",
        left: deletions[rowIndex] ?? null,
        right: additions[rowIndex] ?? null,
        leftMarkers: deletionMarkers.get(rowIndex),
        rightMarkers: additionMarkers.get(rowIndex),
      });
    }
  }

  return rows;
}

function isNoNewlineMarker(line: PositionedDiffLine) {
  return line.kind === "meta" && line.text === "\\ No newline at end of file";
}

function lineContent(line: PositionedDiffLine) {
  return line.kind === "add" || line.kind === "del" || line.kind === "context"
    ? line.text.slice(1)
    : line.text;
}

function RawFilePane({
  owner,
  repo,
  number,
  path,
  side,
}: {
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: "base" | "head";
}) {
  const file = usePullFileAtRef(owner, repo, number, path, side, true);
  return (
    <div data-debug-component="RawFilePane" className="relative min-h-full">
      {file.isLoading ? (
        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading raw file…
        </div>
      ) : file.isError ? (
        <div className="m-3 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load raw file.
          {file.error instanceof Error ? ` ${file.error.message}` : null}
        </div>
      ) : file.data?.status === "missing" ? (
        <p className="p-3 text-sm text-muted-foreground">
          N/A — file does not exist on {side}.
        </p>
      ) : file.data?.status === "binary" ? (
        <p className="p-3 text-sm text-muted-foreground">
          N/A — binary file, cannot display as raw text.
        </p>
      ) : (
        <>
          <div className="sticky top-0 z-10 flex justify-end border-b bg-background/95 px-2 py-1 backdrop-blur">
            <CopyButton
              value={file.data?.content ?? ""}
              label={`Copy raw file: ${visibleCopyPath(path)}`}
            />
          </div>
          <pre className="overflow-x-auto whitespace-pre p-3 text-xs leading-relaxed">
            {file.data?.content ?? ""}
          </pre>
        </>
      )}
    </div>
  );
}

function MarkdownPreviewPane({
  owner,
  repo,
  number,
  path,
  side,
}: {
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: "base" | "head";
}) {
  const file = usePullFileAtRef(owner, repo, number, path, side, true);
  return (
    <div
      data-debug-component="MarkdownPreviewPane"
      className="markdown-diff-preview p-3"
    >
      {file.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading preview…
        </div>
      ) : file.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load preview.
          {file.error instanceof Error ? ` ${file.error.message}` : null}
        </div>
      ) : file.data?.status === "missing" ? (
        <p className="text-sm text-muted-foreground">
          N/A — file does not exist on {side}.
        </p>
      ) : file.data?.status === "binary" ? (
        <p className="text-sm text-muted-foreground">
          N/A — binary file, cannot render as Markdown.
        </p>
      ) : (
        <Markdown
          owner={owner}
          repo={repo}
          typeset
          className="typeset-diff-preview mx-auto"
        >
          {file.data?.content ?? ""}
        </Markdown>
      )}
    </div>
  );
}
