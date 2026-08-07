// PR-detail diff dialog: the full-size modal opened from a file summary row, showing one file's
// diff with line comments plus Raw and (for Markdown) Base/Head rendered previews. The dialog owns
// its own Escape handling, mode switching, per-mode file fetch, and the copy-path resolution for
// renamed / invisible-character filenames. The Files changed section only picks the open file.

import {
  ChevronDown,
  ChevronRight,
  Filter,
  Info,
  Loader2,
  Plus,
  SmilePlus,
  X,
} from "lucide-react";
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
import {
  ArchivedComment,
  CommentActionsMenu,
  commentPreview,
} from "@/components/comment-archive";
import { CommentMetadata } from "@/components/comment-metadata";
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
  type SelectableLines,
  selectableAt,
  selectableLines,
  selectionContains,
  singleSelection,
} from "@/lib/diff-feedback";
import { errorMessage } from "@/lib/error-message";
import { useAutosizeTextarea } from "@/lib/use-autosize-textarea";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { cn } from "@/lib/utils";
import {
  useCreateDiffFeedback,
  useDiffFeedback,
  usePullDiff,
  usePullFileAtRef,
  useReactToDiffFeedback,
  useReplyDiffFeedback,
  useSetDiffFeedbackArchived,
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
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
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
  const backdropDismiss = useBackdropDismiss(onClose);
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
      {...backdropDismiss}
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
                <>
                  <div
                    className="flex overflow-hidden rounded-md border text-xs"
                    aria-label="Diff whitespace"
                  >
                    <ModeButton
                      active={ignoreWhitespace}
                      onClick={() => setIgnoreWhitespace((value) => !value)}
                    >
                      Ignore whitespace
                    </ModeButton>
                  </div>
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
                </>
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
              key={`${copyFilename(file)}:${ignoreWhitespace}`}
              owner={owner}
              repo={repo}
              number={number}
              file={file}
              comments={comments}
              mode={mode}
              diffViewMode={diffViewMode}
              ignoreWhitespace={ignoreWhitespace}
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
  const absolutePath = stableFile?.absolute_path;
  const originalPath =
    stableFile?.original_path ?? file.previousFilename ?? null;

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
            <dt className="text-muted-foreground">Project-relative path</dt>
            <dd className="flex min-w-0 items-start gap-1">
              <span className="min-w-0 flex-1 break-all font-mono">
                {visibleCopyPath(headPath)}
              </span>
              <CopyButton
                value={headPath}
                label={`Copy project-relative path: ${visibleCopyPath(headPath)}`}
                className="size-6"
              />
            </dd>
            <dt className="text-muted-foreground">Absolute path</dt>
            <dd className="flex min-w-0 items-start gap-1">
              <span className="min-w-0 flex-1 break-all font-mono">
                {diff.isPending
                  ? "Loading…"
                  : absolutePath
                    ? visibleCopyPath(absolutePath)
                    : "Unavailable"}
              </span>
              {absolutePath ? (
                <CopyButton
                  value={absolutePath}
                  label={`Copy absolute path: ${visibleCopyPath(absolutePath)}`}
                  className="size-6"
                />
              ) : null}
            </dd>
            {originalPath && originalPath !== headPath ? (
              <>
                <dt className="text-muted-foreground">Original path</dt>
                <dd className="flex min-w-0 items-start gap-1">
                  <span className="min-w-0 flex-1 break-all font-mono">
                    {visibleCopyPath(originalPath)}
                  </span>
                  <CopyButton
                    value={originalPath}
                    label={`Copy original path: ${visibleCopyPath(originalPath)}`}
                    className="size-6"
                  />
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
  ignoreWhitespace,
}: {
  owner: string;
  repo: string;
  number: number;
  file: PullFile;
  comments: PullLineComment[];
  mode: DiffDialogMode;
  diffViewMode: DiffViewMode;
  ignoreWhitespace: boolean;
}) {
  const path = copyFilename(file);
  const diff = usePullDiff(owner, repo, number, path, ignoreWhitespace);
  const feedback = useDiffFeedback(owner, repo, number, { path });
  const reply = useReplyDiffFeedback(owner, repo, number);
  const reaction = useReactToDiffFeedback(owner, repo, number);
  const archive = useSetDiffFeedbackArchived(owner, repo, number);
  const { showError } = useToast();
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const [body, setBody] = useState("");
  const create = useCreateDiffFeedback(
    owner,
    repo,
    number,
    path,
    (error, input) => {
      setSelection({
        side: input.side,
        startLine: input.start_line,
        endLine: input.end_line,
      });
      setBody(input.body);
      showError(errorMessage(error, "Create failed"));
    },
  );
  const stableFile = Array.isArray(diff.data?.files)
    ? diff.data.files[0]
    : undefined;
  const fileThreads = Array.isArray(feedback.data?.threads)
    ? feedback.data.threads
    : [];
  const inlineThreads = fileThreads.filter(
    (thread) => thread.placement === "inline",
  );
  const historicalThreads = fileThreads.filter(
    (thread) => thread.placement === "historical",
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
        onSubmit={() => {
          const submittedBody = body.trim();
          setSelection(null);
          setBody("");
          create.mutate({
            base_sha: diff.data.base_sha,
            head_sha: diff.data.head_sha,
            path: stableFile.path,
            side: selection.side,
            start_line: selection.startLine,
            end_line: selection.endLine,
            body: submittedBody,
          });
        }}
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
        patch={ignoreWhitespace ? stableFile?.patch : file.patch}
        stableLines={stableFile?.lines}
        viewMode={diffViewMode}
        selection={selection}
        selectionContent={commentComposer}
        threads={inlineThreads}
        onSelect={setSelection}
        threadContent={(thread) => (
          <ThreadCard
            owner={owner}
            repo={repo}
            thread={thread}
            busy={reply.isPending}
            reactionBusy={reaction.isPending}
            archiveBusy={archive.isPending}
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
            onArchived={(archived) =>
              archive.mutate(
                { threadId: thread.id, archived },
                {
                  onError: (error) =>
                    showError(errorMessage(error, "Update failed")),
                },
              )
            }
          />
        )}
      />
      {historicalThreads.length > 0 ? (
        <PreviousDiffThreadsSection className="m-2 space-y-2" heading="h4">
          {historicalThreads.map((thread) => (
            <ThreadCard
              key={thread.id}
              owner={owner}
              repo={repo}
              thread={thread}
              busy={reply.isPending}
              reactionBusy={reaction.isPending}
              archiveBusy={archive.isPending}
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
              onArchived={(archived) =>
                archive.mutate(
                  { threadId: thread.id, archived },
                  {
                    onError: (error) =>
                      showError(errorMessage(error, "Update failed")),
                  },
                )
              }
            />
          ))}
        </PreviousDiffThreadsSection>
      ) : null}
      {comments.map((c) => (
        <div key={c.id} className="m-2 rounded-md border bg-muted/20 p-2">
          <div className="mb-1 flex min-w-0 items-start gap-2">
            <CommentMetadata
              author={c.user.login}
              authorType={c.author_type}
              createdAt={c.created_at}
              id={c.id}
              className="flex-1"
            />
            <span className="shrink-0 text-xs text-muted-foreground">
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
  selectable: SelectableLines;
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
    const anchor = thread.resolved_anchor ?? thread.anchor;
    const coordinate = anchor.side === "LEFT" ? line.oldLine : line.newLine;
    return coordinate === anchor.end_line;
  });
}

function threadAnchorsLine(
  threads: DiffFeedbackThread[],
  side: "LEFT" | "RIGHT",
  line: number | null,
) {
  return (
    line != null &&
    threads.some((thread) => {
      const anchor = thread.resolved_anchor ?? thread.anchor;
      return (
        anchor.side === side &&
        line >= anchor.start_line &&
        line <= anchor.end_line
      );
    })
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
                    choice={selectableAt(selectable, "LEFT", line.oldLine)}
                    selected={leftSelected}
                    anchored={leftAnchored}
                    lineSelection={lineSelection}
                  />
                  <LineNumber
                    line={line.newLine}
                    label="New"
                    choice={selectableAt(selectable, "RIGHT", line.newLine)}
                    selected={rightSelected}
                    anchored={rightAnchored}
                    lineSelection={lineSelection}
                  />
                  <td
                    className={cn(
                      "whitespace-pre-wrap break-words pr-4 align-top",
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
                        (thread) =>
                          (thread.resolved_anchor ?? thread.anchor).side ===
                          "RIGHT",
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
                      {(thread.resolved_anchor ?? thread.anchor).side ===
                      "RIGHT" ? (
                        <td colSpan={2} aria-hidden="true" />
                      ) : null}
                      <td colSpan={2}>{threadContent(thread)}</td>
                      {(thread.resolved_anchor ?? thread.anchor).side ===
                      "LEFT" ? (
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
  const textareaRef = useAutosizeTextarea(body);

  return (
    <div className="m-2 rounded-md border bg-background p-3 font-sans">
      <div className="mb-2 text-xs font-medium">
        {selection.side} {selection.startLine}
        {selection.endLine === selection.startLine
          ? ""
          : `–${selection.endLine}`}
      </div>
      <textarea
        ref={textareaRef}
        aria-label="Diff comment"
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            if (body.trim() && !busy) onSubmit();
          }
        }}
        className="min-h-20 w-full resize-none overflow-hidden rounded-md border bg-background p-2 text-sm"
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
        // align-top keeps the number on the first visual line when the content cell wraps.
        "group relative w-12 select-none border-r px-2 text-right align-top text-muted-foreground/70",
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
      // the same selection when the pointer lands on the hidden button. top-2.5 centers it on the
      // first line box (leading-5) so it stays beside the number when the content cell wraps.
      className="absolute left-0.5 top-2.5 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm bg-blue-600 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
  anchored,
  lineSelection,
}: {
  line: PositionedDiffLine | null;
  markers?: PositionedDiffLine[];
  side: "old" | "new";
  selection: DiffSelection | null;
  selectable: DiffRenderProps["selectable"];
  anchored: boolean;
  lineSelection: LineSelectionHandlers;
}) {
  const lineNumber = line
    ? side === "old"
      ? line.oldLine
      : line.newLine
    : null;
  const feedbackSide = side === "old" ? "LEFT" : "RIGHT";
  const choice = selectableAt(selectable, feedbackSide, lineNumber);
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
          "group relative w-12 select-none border-r px-2 text-right align-top text-muted-foreground/70",
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
          "min-w-0 align-top",
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
  const archive = useSetDiffFeedbackArchived(owner, repo, number);
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
    <PreviousDiffThreadsSection className="space-y-2" heading="h3">
      {historical.map((thread) => (
        <ThreadCard
          key={thread.id}
          owner={owner}
          repo={repo}
          thread={thread}
          busy={reply.isPending}
          reactionBusy={reaction.isPending}
          archiveBusy={archive.isPending}
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
          onArchived={(archived) =>
            archive.mutate(
              { threadId: thread.id, archived },
              {
                onError: (error) =>
                  showError(errorMessage(error, "Update failed")),
              },
            )
          }
        />
      ))}
    </PreviousDiffThreadsSection>
  );
}

/** Collapsible wrapper for the Previous diff threads block (collapsed by default). */
function PreviousDiffThreadsSection({
  className,
  heading,
  children,
}: {
  className?: string;
  heading: "h3" | "h4";
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const headingClassName =
    heading === "h3"
      ? "text-sm font-semibold"
      : "text-xs font-semibold text-muted-foreground";
  return (
    <section className={className} aria-label="Previous diff threads">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((shown) => !shown)}
        className={`flex w-full items-center gap-1 text-left hover:text-foreground ${headingClassName}`}
      >
        <Chevron className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Previous diff threads</span>
      </button>
      {expanded ? <div className="space-y-2">{children}</div> : null}
    </section>
  );
}

function ThreadCard({
  owner,
  repo,
  thread,
  busy,
  reactionBusy,
  archiveBusy,
  onReact,
  onReply,
  onArchived,
}: {
  owner: string;
  repo: string;
  thread: DiffFeedbackThread;
  busy: boolean;
  reactionBusy: boolean;
  archiveBusy: boolean;
  onReact: (messageId: number, emoji: string) => void;
  onReply: (body: string) => void;
  onArchived: (archived: boolean) => void;
}) {
  const [replyBody, setReplyBody] = useState("");
  const replyTextareaRef = useAutosizeTextarea(replyBody);
  const archived = thread.archived_at != null;
  const displayedAnchor =
    thread.freshness === "current" && thread.resolved_anchor
      ? thread.resolved_anchor
      : thread.anchor;

  function submitReply() {
    const trimmed = replyBody.trim();
    if (!trimmed || busy) return;
    onReply(trimmed);
    setReplyBody("");
  }

  const menu = (
    <CommentActionsMenu
      label={`Actions for diff thread ${thread.id}`}
      copyMarkdown={thread.messages
        .map((message) => message.body)
        .filter((body) => body !== "")
        .join("\n\n")}
      archived={archived}
      busy={archiveBusy}
      onArchived={onArchived}
    />
  );
  const conversation = (
    <>
      <div className="space-y-2">
        {thread.messages.map((message) => (
          <div key={message.id} className="rounded-md bg-muted/20 p-2">
            <CommentMetadata
              author={message.author}
              authorType={message.author_type}
              createdAt={message.created_at}
              id={message.id}
              className="mb-1"
            />
            <Markdown owner={owner} repo={repo}>
              {message.body}
            </Markdown>
            <div className="mt-2 flex items-center gap-1">
              {(message.reactions ?? []).map((reaction) => (
                <button
                  type="button"
                  key={reaction.emoji}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs",
                    reaction.reacted
                      ? "bg-accent text-accent-foreground"
                      : "bg-background",
                  )}
                  aria-label={`${reaction.emoji} reaction: ${reaction.count}`}
                  aria-pressed={reaction.reacted}
                  disabled={reactionBusy}
                  onClick={() => onReact(message.id, reaction.emoji)}
                >
                  {reaction.emoji} {reaction.count}
                </button>
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
          ref={replyTextareaRef}
          aria-label={`Reply to thread ${thread.id}`}
          value={replyBody}
          onChange={(event) => setReplyBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              submitReply();
            }
          }}
          className="min-h-16 w-full resize-none overflow-hidden rounded-md border bg-background p-2 text-sm"
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
    </>
  );

  return (
    <article
      className={cn(
        "m-2 rounded-md border bg-background font-sans text-sm",
        archived ? "border-dashed px-3 py-2" : "p-3",
      )}
      aria-label={`Diff thread ${thread.id}`}
    >
      {archived ? (
        <ArchivedComment
          label={`Archived diff thread ${thread.id}`}
          preview={`${displayedAnchor.path}:${displayedAnchor.start_line} ${commentPreview(
            thread.messages[0]?.body ?? "",
          )}`}
          menu={menu}
        >
          <header className="mb-2 flex justify-end">
            <DiffAnchorInfoPopover thread={thread} anchor={displayedAnchor} />
          </header>
          {conversation}
        </ArchivedComment>
      ) : (
        <>
          <header className="mb-2 flex items-center justify-end gap-1">
            <DiffAnchorInfoPopover thread={thread} anchor={displayedAnchor} />
            {menu}
          </header>
          {conversation}
        </>
      )}
    </article>
  );
}

type DisplayedDiffAnchor = Pick<
  DiffFeedbackThread["anchor"],
  "path" | "side" | "start_line" | "end_line"
>;

function DiffAnchorInfoPopover({
  thread,
  anchor,
}: {
  thread: DiffFeedbackThread;
  anchor: DisplayedDiffAnchor;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const line = `${anchor.side} ${anchor.start_line}${
    anchor.end_line === anchor.start_line ? "" : `–${anchor.end_line}`
  }`;
  const status =
    thread.freshness.charAt(0).toUpperCase() + thread.freshness.slice(1);
  const reason = thread.outdated_reason
    ? thread.outdated_reason.charAt(0).toUpperCase() +
      thread.outdated_reason.slice(1)
    : null;

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
        aria-label={`Show diff anchor information for thread ${thread.id}`}
        aria-expanded={open}
        className="size-6 text-muted-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <Info className="size-3.5" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label={`Diff anchor information for thread ${thread.id}`}
          className="absolute right-0 top-full z-20 mt-1 w-96 max-w-[calc(100vw-3rem)] rounded-md border bg-background p-3 text-foreground shadow-md"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <h4 className="text-sm font-semibold">Diff anchor</h4>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close diff anchor information"
              className="-mr-1 -mt-1 size-6 text-muted-foreground"
              onClick={() => setOpen(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            <dt className="text-muted-foreground">Status</dt>
            <dd
              className={cn(
                thread.freshness !== "current" &&
                  "text-amber-700 dark:text-amber-300",
              )}
            >
              {status}
            </dd>
            <dt className="text-muted-foreground">Path</dt>
            <dd className="break-all font-mono">{anchor.path}</dd>
            <dt className="text-muted-foreground">Location</dt>
            <dd className="font-mono">{line}</dd>
            {reason ? (
              <>
                <dt className="text-muted-foreground">Reason</dt>
                <dd>{reason}</dd>
              </>
            ) : null}
          </dl>
          {thread.freshness !== "current" && thread.original_context ? (
            <div className="mt-3">
              <h5 className="mb-1 text-xs font-medium">Historical context</h5>
              <pre
                className="overflow-x-auto rounded-md border bg-muted/20 p-2 font-mono text-xs"
                aria-label={`Historical context for thread ${thread.id}`}
              >
                {thread.original_context
                  .map(
                    (contextLine) =>
                      `${contextLine.anchored ? ">" : " "} ${contextLine.text}`,
                  )
                  .join("\n")}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
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
