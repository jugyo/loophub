// PR-detail diff dialog: the full-size modal opened from a file summary row, showing one file's
// diff with line comments plus Raw and (for Markdown) Base/Head rendered previews. The dialog owns
// its own Escape handling, mode switching, per-mode file fetch, and the copy-path resolution for
// renamed / invisible-character filenames. The Files changed section only picks the open file.

import { Filter, Info, Loader2, Plus, SmilePlus, X } from "lucide-react";
import {
  Fragment,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DiffFeedbackThread,
  PullDiff,
  PullFile,
  PullLineComment,
} from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { DiffCommentCount } from "@/components/diff-comment-count";
import { DiffStat } from "@/components/diff-stat";
import { FileStatusBadge } from "@/components/file-status-badge";
import { Markdown } from "@/components/markdown";
import { useToast } from "@/components/toast";
import { Button, disabledButtonStateClasses } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type DiffLineKind,
  type PositionedDiffLine,
  parsePositionedPatch,
} from "@/lib/diff";
import {
  type DiffSelection,
  dragSelection,
  type SelectableDiffLine,
  selectableLines,
  selectionContains,
  singleSelection,
} from "@/lib/diff-feedback";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";
import {
  useCreateDiffFeedback,
  useDiffFeedback,
  usePullDiff,
  usePullFileAtRef,
  useReactToDiffFeedback,
  useReplyDiffFeedback,
} from "@/queries/pulls";

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

function shellQuote(value: string) {
  if (/^[\w./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function gitShowCommand(commit: string, path: string) {
  return `git show ${shellQuote(`${commit}:${path}`)}`;
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
const DIFF_FEEDBACK_REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀"] as const;

function globPatternToRegExp(pattern: string) {
  const normalizedPattern = pattern.includes("/") ? pattern : `**/${pattern}`;
  let source = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];
    if (char === "*") {
      if (normalizedPattern[index + 1] === "*") {
        if (normalizedPattern[index + 2] === "/") {
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
  commentCounts = {},
  onSelectFile,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  files: PullFile[];
  file: PullFile;
  comments: PullLineComment[];
  commentCounts?: Readonly<Record<string, number>>;
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
                      "grid w-full grid-cols-[auto_minmax(0,max-content)_auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-left hover:bg-muted",
                      selected &&
                        "bg-accent font-medium text-accent-foreground",
                    )}
                    onClick={() => onSelectFile(sidebarFile.filename)}
                  >
                    <FileStatusBadge status={sidebarFile.status} />
                    <span className="min-w-0 truncate font-mono text-xs [direction:rtl]">
                      {sidebarFile.filename}
                    </span>
                    <DiffStat
                      additions={sidebarFile.additions}
                      deletions={sidebarFile.deletions}
                      className="justify-self-end text-[11px]"
                    />
                    <span aria-hidden="true" />
                    <DiffCommentCount
                      count={commentCounts[sidebarFile.filename] ?? 0}
                      className="text-[11px]"
                    />
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
                  key={`copy-${copyPath}`}
                  value={copyPath}
                  label={`Copy file path: ${copyPath}`}
                  className="size-6"
                />
                <FileInfoPopover
                  key={`info-${copyPath}`}
                  owner={owner}
                  repo={repo}
                  number={number}
                  file={file}
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
              key={copyFilename(file)}
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

function FileInfoPopover({
  owner,
  repo,
  number,
  file,
}: {
  owner: string;
  repo: string;
  number: number;
  file: PullFile;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const path = copyFilename(file);
  const diff = usePullDiff(owner, repo, number, path);
  const stableFile = Array.isArray(diff.data?.files)
    ? diff.data.files[0]
    : undefined;
  const headPath = stableFile?.path ?? path;
  const originalPath =
    stableFile?.original_path ?? file.previousFilename ?? null;
  const references = stableFile?.references ?? [];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Show file information: ${visibleCopyPath(path)}`}
        aria-expanded={open}
        className="size-6 text-muted-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <Info className="size-3.5" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label={`File information: ${visibleCopyPath(path)}`}
          className="absolute left-0 top-full z-20 mt-1 w-[28rem] max-w-[calc(100vw-3rem)] rounded-md border bg-background p-3 text-foreground shadow-md"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <h4 className="text-sm font-semibold">File information</h4>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close file information"
              className="-mr-1 -mt-1 size-6 text-muted-foreground"
              onClick={() => setOpen(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            <dt className="text-muted-foreground">Path</dt>
            <dd className="break-all font-mono">{visibleCopyPath(headPath)}</dd>
            {originalPath && originalPath !== headPath ? (
              <>
                <dt className="text-muted-foreground">Original path</dt>
                <dd className="break-all font-mono">
                  {visibleCopyPath(originalPath)}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Change</dt>
            <dd>{file.status}</dd>
            <dt className="text-muted-foreground">Lines</dt>
            <dd>
              <DiffStat additions={file.additions} deletions={file.deletions} />
            </dd>
          </dl>
          <div className="mt-3 border-t pt-3">
            <p className="mb-1.5 text-xs font-medium">Git command</p>
            {diff.isPending ? (
              <p className="text-xs text-muted-foreground">
                Loading commit references…
              </p>
            ) : diff.isError ? (
              <p className="text-xs text-destructive">
                Git reference is unavailable.
              </p>
            ) : (
              <div className="space-y-2">
                {references.map((reference) => {
                  const command = gitShowCommand(
                    reference.commit,
                    reference.path,
                  );
                  return (
                    <div key={reference.label} className="space-y-1">
                      {references.length > 1 ? (
                        <p className="text-[11px] text-muted-foreground">
                          {reference.label}
                        </p>
                      ) : null}
                      <div className="flex items-start gap-1 rounded bg-muted/60 p-1.5">
                        <code className="min-w-0 flex-1 break-all text-[11px]">
                          {command}
                        </code>
                        <CopyButton
                          value={command}
                          label={`Copy ${reference.label.toLowerCase()} git command`}
                          className="size-6 shrink-0"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
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
  const path = copyFilename(file);
  const diff = usePullDiff(owner, repo, number, path);
  const feedback = useDiffFeedback(owner, repo, number, { path });
  const create = useCreateDiffFeedback(owner, repo, number);
  const reply = useReplyDiffFeedback(owner, repo, number);
  const reaction = useReactToDiffFeedback(owner, repo, number);
  const { showError } = useToast();
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const [body, setBody] = useState("");
  const stableFile = Array.isArray(diff.data?.files)
    ? diff.data.files[0]
    : undefined;
  const fileThreads = Array.isArray(feedback.data?.threads)
    ? feedback.data.threads
    : [];
  const currentThreads = fileThreads.filter(
    (thread) => thread.freshness === "current",
  );
  const historicalThreads = fileThreads.filter(
    (thread) => thread.freshness !== "current",
  );
  const commentComposer =
    selection && stableFile && diff.data ? (
      <DiffCommentComposer
        selection={selection}
        body={body}
        busy={create.isPending}
        onBodyChange={setBody}
        onCancel={() => {
          setSelection(null);
          setBody("");
        }}
        onSubmit={() =>
          create.mutate(
            {
              base_sha: diff.data.base_sha,
              head_sha: diff.data.head_sha,
              path: stableFile.path,
              side: selection.side,
              start_line: selection.startLine,
              end_line: selection.endLine,
              body: body.trim(),
            },
            {
              onSuccess: () => {
                setSelection(null);
                setBody("");
              },
              onError: (error) =>
                showError(errorMessage(error, "Create failed")),
            },
          )
        }
      />
    ) : null;

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
      {diff.isError || feedback.isError ? (
        <div className="m-2 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-sm text-destructive">
          Failed to load diff feedback.
        </div>
      ) : null}
      <DialogDiff
        patch={file.patch}
        stableLines={stableFile?.lines}
        viewMode={diffViewMode}
        selection={selection}
        selectionContent={commentComposer}
        threads={currentThreads}
        onSelect={setSelection}
        threadContent={(thread) => (
          <ThreadCard
            owner={owner}
            repo={repo}
            thread={thread}
            busy={reply.isPending}
            reactionBusy={reaction.isPending}
            onReact={(messageId, emoji) =>
              reaction.mutate(
                { messageId, emoji },
                {
                  onError: (error) =>
                    showError(errorMessage(error, "Reaction failed")),
                },
              )
            }
            onReply={(replyBody) =>
              reply.mutate(
                {
                  threadId: thread.id,
                  body: replyBody,
                },
                {
                  onError: (error) =>
                    showError(errorMessage(error, "Reply failed")),
                },
              )
            }
          />
        )}
      />
      {historicalThreads.length > 0 ? (
        <section className="m-2 space-y-2" aria-label="Previous diff threads">
          <h4 className="text-xs font-semibold text-muted-foreground">
            Previous diff threads
          </h4>
          {historicalThreads.map((thread) => (
            <ThreadCard
              key={thread.id}
              owner={owner}
              repo={repo}
              thread={thread}
              busy={reply.isPending}
              reactionBusy={reaction.isPending}
              onReact={(messageId, emoji) =>
                reaction.mutate(
                  { messageId, emoji },
                  {
                    onError: (error) =>
                      showError(errorMessage(error, "Reaction failed")),
                  },
                )
              }
              onReply={(replyBody) =>
                reply.mutate(
                  {
                    threadId: thread.id,
                    body: replyBody,
                  },
                  {
                    onError: (error) =>
                      showError(errorMessage(error, "Reply failed")),
                  },
                )
              }
            />
          ))}
        </section>
      ) : null}
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
  stableLines,
  viewMode,
  selection,
  selectionContent,
  threads,
  onSelect,
  threadContent,
}: {
  patch: string | undefined | null;
  stableLines: PullDiff["files"][number]["lines"] | undefined;
  viewMode: DiffViewMode;
  selection: DiffSelection | null;
  selectionContent: ReactNode;
  threads: DiffFeedbackThread[];
  onSelect: (selection: DiffSelection) => void;
  threadContent: (thread: DiffFeedbackThread) => ReactNode;
}) {
  const { dragging, lineSelection } = useLineSelectionDrag(onSelect);
  const lines = parsePositionedPatch(patch);
  const selectable = selectableLines(stableLines ?? []);
  if (lines.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No textual diff.
      </p>
    );
  }
  // The composer stays hidden until the drag ends: inserting its row mid-drag would move the
  // rows the pointer is still travelling over.
  const props: DiffRenderProps = {
    lines,
    selectable,
    selection,
    selectionContent: dragging ? null : selectionContent,
    threads,
    lineSelection,
    threadContent,
  };
  return viewMode === "unified" ? (
    <UnifiedDiff {...props} />
  ) : (
    <SplitDiff {...props} />
  );
}

type LineSelectionHandlers = {
  // The + button shown on hover comments on that single line.
  onSelect: (line: SelectableDiffLine) => void;
  onDragStart: (line: SelectableDiffLine) => void;
  onDragEnter: (line: SelectableDiffLine) => void;
};

function useLineSelectionDrag(onSelect: (selection: DiffSelection) => void) {
  const [anchor, setAnchor] = useState<SelectableDiffLine | null>(null);

  useEffect(() => {
    if (!anchor) return;
    function onPointerUp() {
      setAnchor(null);
    }
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  }, [anchor]);

  const lineSelection: LineSelectionHandlers = {
    onSelect: (line) => onSelect(singleSelection(line)),
    onDragStart: (line) => {
      setAnchor(line);
      onSelect(singleSelection(line));
    },
    onDragEnter: (line) => {
      if (!anchor) return;
      const next = dragSelection(anchor, line);
      if (next) onSelect(next);
    },
  };
  return { dragging: anchor !== null, lineSelection };
}

type DiffRenderProps = {
  lines: PositionedDiffLine[];
  selectable: Map<number, SelectableDiffLine[]>;
  selection: DiffSelection | null;
  selectionContent: ReactNode;
  threads: DiffFeedbackThread[];
  lineSelection: LineSelectionHandlers;
  threadContent: (thread: DiffFeedbackThread) => ReactNode;
};

function threadsEndingAt(
  threads: DiffFeedbackThread[],
  line: PositionedDiffLine,
) {
  return threads.filter((thread) => {
    const coordinate =
      thread.anchor.side === "LEFT" ? line.oldLine : line.newLine;
    return coordinate === thread.anchor.end_line;
  });
}

function threadAnchorsLine(
  threads: DiffFeedbackThread[],
  side: "LEFT" | "RIGHT",
  line: number | null,
) {
  return (
    line != null &&
    threads.some(
      (thread) =>
        thread.anchor.side === side &&
        line >= thread.anchor.start_line &&
        line <= thread.anchor.end_line,
    )
  );
}

function selectionEndsAt(
  selection: DiffSelection | null,
  side: "LEFT" | "RIGHT",
  line: PositionedDiffLine | null,
) {
  const coordinate =
    side === "LEFT" ? (line?.oldLine ?? null) : (line?.newLine ?? null);
  return (
    selection?.side === side &&
    coordinate != null &&
    coordinate === selection.endLine
  );
}

function UnifiedDiff({
  lines,
  selectable,
  selection,
  selectionContent,
  threads,
  lineSelection,
  threadContent,
}: DiffRenderProps) {
  return (
    <div className="[container-type:inline-size]">
      <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
        <colgroup>
          <col className="w-12" />
          <col className="w-12" />
          <col />
        </colgroup>
        <tbody>
          {lines.map((line, index) => {
            const choices = selectable.get(index) ?? [];
            const ending = threadsEndingAt(threads, line);
            const leftAnchored = threadAnchorsLine(
              threads,
              "LEFT",
              line.oldLine,
            );
            const rightAnchored = threadAnchorsLine(
              threads,
              "RIGHT",
              line.newLine,
            );
            const leftSelected = selectionContains(
              selection,
              "LEFT",
              line.oldLine,
            );
            const rightSelected = selectionContains(
              selection,
              "RIGHT",
              line.newLine,
            );
            return (
              <Fragment key={`${line.oldLine}:${line.newLine}:${index}`}>
                <tr
                  className={DIFF_LINE_CLASS[line.kind]}
                  data-line-kind={line.kind}
                >
                  <LineNumber
                    line={line.oldLine}
                    label="Old"
                    choice={choices.find((choice) => choice.side === "LEFT")}
                    selected={leftSelected}
                    anchored={leftAnchored}
                    lineSelection={lineSelection}
                  />
                  <LineNumber
                    line={line.newLine}
                    label="New"
                    choice={choices.find((choice) => choice.side === "RIGHT")}
                    selected={rightSelected}
                    anchored={rightAnchored}
                    lineSelection={lineSelection}
                  />
                  <td
                    className={cn(
                      "whitespace-pre-wrap break-words pr-4",
                      (leftAnchored || rightAnchored) &&
                        "bg-amber-500/10 shadow-[inset_3px_0_0_0] shadow-amber-500/70",
                      (leftSelected || rightSelected) && "bg-blue-500/10",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block w-5 select-none text-center"
                    >
                      {DIFF_LINE_MARKER[line.kind]}
                    </span>
                    {lineContent(line) || " "}
                  </td>
                </tr>
                {selectionContent &&
                (selectionEndsAt(selection, "LEFT", line) ||
                  selectionEndsAt(selection, "RIGHT", line)) ? (
                  <tr data-diff-comment-row>
                    <td colSpan={3}>
                      <div className="sticky left-0 w-[100cqw]">
                        {selectionContent}
                      </div>
                    </td>
                  </tr>
                ) : null}
                {ending.map((thread) => (
                  <tr key={`thread:${thread.id}`}>
                    <td colSpan={3}>{threadContent(thread)}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SplitDiff(props: DiffRenderProps) {
  const {
    lines,
    selectable,
    selection,
    selectionContent,
    threads,
    lineSelection,
    threadContent,
  } = props;
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
              <Fragment key={`line:${index}`}>
                <tr>
                  <SplitLine
                    line={row.left}
                    markers={row.leftMarkers}
                    side="old"
                    selection={selection}
                    selectable={selectable}
                    sourceIndex={row.left ? lines.indexOf(row.left) : null}
                    anchored={
                      row.left
                        ? threadAnchorsLine(threads, "LEFT", row.left.oldLine)
                        : false
                    }
                    lineSelection={lineSelection}
                  />
                  <SplitLine
                    line={row.right}
                    markers={row.rightMarkers}
                    side="new"
                    selection={selection}
                    selectable={selectable}
                    sourceIndex={row.right ? lines.indexOf(row.right) : null}
                    anchored={
                      row.right
                        ? threadAnchorsLine(threads, "RIGHT", row.right.newLine)
                        : false
                    }
                    lineSelection={lineSelection}
                  />
                </tr>
                {selectionContent &&
                (selectionEndsAt(selection, "LEFT", row.left) ||
                  selectionEndsAt(selection, "RIGHT", row.right)) ? (
                  <tr data-diff-comment-row>
                    {selection?.side === "RIGHT" ? (
                      <td colSpan={2} aria-hidden="true" />
                    ) : null}
                    <td colSpan={2}>{selectionContent}</td>
                    {selection?.side === "LEFT" ? (
                      <td colSpan={2} aria-hidden="true" />
                    ) : null}
                  </tr>
                ) : null}
                {[
                  ...(row.left ? threadsEndingAt(threads, row.left) : []),
                  ...(row.right
                    ? threadsEndingAt(threads, row.right).filter(
                        (thread) => thread.anchor.side === "RIGHT",
                      )
                    : []),
                ]
                  .filter(
                    (thread, threadIndex, all) =>
                      all.findIndex((item) => item.id === thread.id) ===
                      threadIndex,
                  )
                  .map((thread) => (
                    <tr key={`thread:${thread.id}`}>
                      {thread.anchor.side === "RIGHT" ? (
                        <td colSpan={2} aria-hidden="true" />
                      ) : null}
                      <td colSpan={2}>{threadContent(thread)}</td>
                      {thread.anchor.side === "LEFT" ? (
                        <td colSpan={2} aria-hidden="true" />
                      ) : null}
                    </tr>
                  ))}
              </Fragment>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function DiffCommentComposer({
  selection,
  body,
  busy,
  onBodyChange,
  onCancel,
  onSubmit,
}: {
  selection: DiffSelection;
  body: string;
  busy: boolean;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="m-2 rounded-md border bg-background p-3 font-sans">
      <div className="mb-2 text-xs font-medium">
        {selection.side} {selection.startLine}
        {selection.endLine === selection.startLine
          ? ""
          : `–${selection.endLine}`}
      </div>
      <textarea
        aria-label="Diff comment"
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            if (body.trim() && !busy) onSubmit();
          }
        }}
        className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
        placeholder="Leave a comment…"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!body.trim() || busy} onClick={onSubmit}>
          Comment
        </Button>
      </div>
    </div>
  );
}

function LineNumber({
  line,
  label,
  choice,
  selected,
  anchored,
  lineSelection,
}: {
  line: number | null;
  label: "Old" | "New";
  choice?: SelectableDiffLine;
  selected: boolean;
  anchored: boolean;
  lineSelection: LineSelectionHandlers;
}) {
  return (
    <td
      aria-label={line === null ? undefined : `${label} line ${line}`}
      className={cn(
        "group relative w-12 select-none border-r px-2 text-right text-muted-foreground/70",
        choice && "cursor-pointer hover:bg-blue-500/15",
        anchored &&
          "bg-amber-500/15 text-amber-800 shadow-[inset_3px_0_0_0] shadow-amber-500/70 dark:text-amber-200",
        selected && "bg-blue-500/20 text-foreground",
      )}
      data-thread-anchor={anchored || undefined}
      data-selected={selected || undefined}
      {...lineDragProps(choice, lineSelection)}
    >
      {choice ? (
        <AddCommentButton
          label={`${label.toLowerCase()} line ${line}`}
          onClick={() => lineSelection.onSelect(choice)}
        />
      ) : null}
      {line}
    </td>
  );
}

// Pressing a line number starts a range; moving onto another number cell of the same side and
// hunk grows it, and the document-level pointerup in useLineSelectionDrag ends it.
function lineDragProps(
  choice: SelectableDiffLine | undefined,
  lineSelection: LineSelectionHandlers,
) {
  if (!choice) return {};
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Keep the browser from starting a text selection across the diff while dragging.
      event.preventDefault();
      lineSelection.onDragStart(choice);
    },
    onPointerEnter: () => lineSelection.onDragEnter(choice),
  };
}

function AddCommentButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      // Kept mounted but invisible so it stays reachable by keyboard; the cell below it starts
      // the same selection when the pointer lands on the hidden button.
      className="absolute left-0.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm bg-blue-600 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      aria-label={`Comment on ${label}`}
      onClick={onClick}
    >
      <Plus className="size-3" aria-hidden="true" />
    </button>
  );
}

function SplitLine({
  line,
  markers = [],
  side,
  selection,
  selectable,
  sourceIndex,
  anchored,
  lineSelection,
}: {
  line: PositionedDiffLine | null;
  markers?: PositionedDiffLine[];
  side: "old" | "new";
  selection: DiffSelection | null;
  selectable: DiffRenderProps["selectable"];
  sourceIndex: number | null;
  anchored: boolean;
  lineSelection: LineSelectionHandlers;
}) {
  const lineNumber = line
    ? side === "old"
      ? line.oldLine
      : line.newLine
    : null;
  const feedbackSide = side === "old" ? "LEFT" : "RIGHT";
  const choice =
    sourceIndex == null
      ? undefined
      : selectable
          .get(sourceIndex)
          ?.find((candidate) => candidate.side === feedbackSide);
  const selected = selectionContains(selection, feedbackSide, lineNumber);
  return (
    <>
      <td
        aria-label={
          lineNumber === null
            ? undefined
            : `${side === "old" ? "Old" : "New"} line ${lineNumber}`
        }
        className={cn(
          "group relative w-12 select-none border-r px-2 text-right text-muted-foreground/70",
          line && DIFF_LINE_CLASS[line.kind],
          side === "new" && "border-l",
          choice && "cursor-pointer hover:bg-blue-500/15",
          anchored &&
            "bg-amber-500/15 text-amber-800 shadow-[inset_3px_0_0_0] shadow-amber-500/70 dark:text-amber-200",
          selected && "bg-blue-500/20 text-foreground",
        )}
        data-thread-anchor={anchored || undefined}
        data-selected={selected || undefined}
        {...lineDragProps(choice, lineSelection)}
      >
        {choice ? (
          <AddCommentButton
            label={`${side} line ${lineNumber}`}
            onClick={() => lineSelection.onSelect(choice)}
          />
        ) : null}
        {lineNumber}
      </td>
      <td
        className={cn(
          "min-w-0",
          line && DIFF_LINE_CLASS[line.kind],
          anchored &&
            "bg-amber-500/10 shadow-[inset_3px_0_0_0] shadow-amber-500/70",
          selected && "bg-blue-500/10",
        )}
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

export function DiffFeedbackHistory({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const feedback = useDiffFeedback(owner, repo, number, { orphaned: true });
  const reply = useReplyDiffFeedback(owner, repo, number);
  const reaction = useReactToDiffFeedback(owner, repo, number);
  const { showError } = useToast();
  const historical = feedback.data?.threads ?? [];
  if (feedback.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading previous threads…
      </div>
    );
  }
  if (feedback.isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load previous diff threads.
        {feedback.error instanceof Error ? ` ${feedback.error.message}` : null}
      </div>
    );
  }
  if (historical.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Previous diff threads">
      <h3 className="text-sm font-semibold">Previous diff threads</h3>
      {historical.map((thread) => (
        <ThreadCard
          key={thread.id}
          owner={owner}
          repo={repo}
          thread={thread}
          busy={reply.isPending}
          reactionBusy={reaction.isPending}
          onReact={(messageId, emoji) =>
            reaction.mutate(
              { messageId, emoji },
              {
                onError: (error) =>
                  showError(errorMessage(error, "Reaction failed")),
              },
            )
          }
          onReply={(body) =>
            reply.mutate(
              { threadId: thread.id, body },
              {
                onError: (error) =>
                  showError(errorMessage(error, "Reply failed")),
              },
            )
          }
        />
      ))}
    </section>
  );
}

function ThreadCard({
  owner,
  repo,
  thread,
  busy,
  reactionBusy,
  onReact,
  onReply,
}: {
  owner: string;
  repo: string;
  thread: DiffFeedbackThread;
  busy: boolean;
  reactionBusy: boolean;
  onReact: (messageId: number, emoji: string) => void;
  onReply: (body: string) => void;
}) {
  const [replyBody, setReplyBody] = useState("");

  function submitReply() {
    const trimmed = replyBody.trim();
    if (!trimmed || busy) return;
    onReply(trimmed);
    setReplyBody("");
  }

  return (
    <article
      className="m-2 rounded-md border bg-background p-3 font-sans text-sm"
      aria-label={`Diff thread ${thread.id}`}
    >
      <header className="mb-2 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold">@{thread.created_by}</span>
          {thread.freshness !== "current" ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">
              {thread.freshness}
            </span>
          ) : null}
        </div>
        <span className="text-muted-foreground">
          {thread.anchor.side} {thread.anchor.start_line}
          {thread.anchor.end_line === thread.anchor.start_line
            ? ""
            : `–${thread.anchor.end_line}`}
        </span>
      </header>
      <div className="space-y-2">
        {thread.messages.map((message) => (
          <div key={message.id} className="rounded-md bg-muted/20 p-2">
            <div className="mb-1 text-xs text-muted-foreground">
              @{message.author}
            </div>
            <Markdown owner={owner} repo={repo}>
              {message.body}
            </Markdown>
            <div className="mt-2 flex items-center gap-1">
              {(message.reactions ?? []).map((reaction) => (
                <span
                  key={reaction.emoji}
                  className="rounded-full border bg-background px-2 py-0.5 text-xs"
                  aria-label={`${reaction.emoji} reaction: ${reaction.count}`}
                >
                  {reaction.emoji} {reaction.count}
                </span>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Add reaction to comment ${message.id}`}
                    disabled={reactionBusy}
                  >
                    <SmilePlus className="size-3.5" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="flex min-w-0 gap-1 p-1"
                >
                  {DIFF_FEEDBACK_REACTIONS.map((emoji) => (
                    <DropdownMenuItem
                      key={emoji}
                      className="flex size-8 cursor-pointer items-center justify-center p-0 text-base"
                      aria-label={`React with ${emoji}`}
                      onSelect={() => onReact(message.id, emoji)}
                    >
                      {emoji}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2">
        <textarea
          aria-label={`Reply to thread ${thread.id}`}
          value={replyBody}
          onChange={(event) => setReplyBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              submitReply();
            }
          }}
          className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
          placeholder="Reply…"
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!replyBody.trim() || busy}
            onClick={submitReply}
          >
            Reply
          </Button>
        </div>
      </div>
    </article>
  );
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
      className="markdown-diff-preview px-3 py-8"
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
