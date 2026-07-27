// PR-detail diff dialog: the full-size modal opened from a file summary row, showing one file's
// diff with line comments plus Raw and (for Markdown) Base/Head rendered previews. The dialog owns
// its own Escape handling, mode switching, per-mode file fetch, and the copy-path resolution for
// renamed / invisible-character filenames. The Files changed section only picks the open file and
// drives prev/next navigation through props.

import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PullFile, PullLineComment } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { DiffLines } from "@/components/diff-lines";
import { DiffStat } from "@/components/diff-stat";
import { Markdown } from "@/components/markdown";
import { Button, disabledButtonStateClasses } from "@/components/ui/button";
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

export function DiffFileDialog({
  owner,
  repo,
  number,
  file,
  comments,
  hasPreviousFile,
  hasNextFile,
  onPreviousFile,
  onNextFile,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  file: PullFile;
  comments: PullLineComment[];
  hasPreviousFile: boolean;
  hasNextFile: boolean;
  onPreviousFile: () => void;
  onNextFile: () => void;
  onClose: () => void;
}) {
  const [standardMode, setStandardMode] =
    useState<StandardDiffDialogMode>("diff");
  const [markdownMode, setMarkdownMode] = useState<DiffDialogMode>("diff");
  const mouseDownStartedOnBackdrop = useRef(false);
  const copyPath = visibleCopyPath(copyFilename(file));
  const isMarkdown =
    MARKDOWN_FILENAME.test(file.filename) && !isSyntheticRenameFilename(file);
  const mode = isMarkdown ? markdownMode : standardMode;

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
        className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      >
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
              <span>{file.status}</span>
              <DiffStat additions={file.additions} deletions={file.deletions} />
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
            <div className="flex overflow-hidden rounded-md border text-xs">
              <ModeButton disabled={!hasPreviousFile} onClick={onPreviousFile}>
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
        <div className="min-h-0 flex-1 overflow-auto">
          <FileDiffContent
            owner={owner}
            repo={repo}
            number={number}
            file={file}
            comments={comments}
            mode={mode}
          />
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
}: {
  owner: string;
  repo: string;
  number: number;
  file: PullFile;
  comments: PullLineComment[];
  mode: DiffDialogMode;
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
      <DiffLines patch={file.patch} />
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
    <div data-debug-component="MarkdownPreviewPane" className="p-3">
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
