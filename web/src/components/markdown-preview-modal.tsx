// Full-size Markdown preview modal for a diff file (#435): renders the whole-file Markdown at
// the PR's base and head commits (not the diff itself — see the Preview button in
// pull-detail.tsx's FileDiff), reusing the shared <Markdown> renderer. Follows the same
// role="dialog" + fixed inset-0 backdrop pattern as pull-debug-menu.tsx / create-issue-modal.tsx.

import { Loader2, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePullFileAtRef } from "@/queries/pulls";

type Side = "base" | "head";

export function MarkdownPreviewModal({
  owner,
  repo,
  number,
  path,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  path: string;
  onClose: () => void;
}) {
  const [side, setSide] = useState<Side>("head");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Both sides are fetched up front so switching base/head is instant and doesn't re-fetch.
  const base = usePullFileAtRef(owner, repo, number, path, "base", true);
  const head = usePullFileAtRef(owner, repo, number, path, "head", true);
  const active = side === "base" ? base : head;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Markdown preview for ${path}`}
        className="flex w-full max-w-4xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="truncate text-sm font-semibold">{path}</h2>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded-md border text-xs">
              <SideButton
                active={side === "base"}
                onClick={() => setSide("base")}
              >
                Base
              </SideButton>
              <SideButton
                active={side === "head"}
                onClick={() => setSide("head")}
              >
                Head
              </SideButton>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close preview"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {active.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading preview…
            </div>
          ) : active.isError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              Failed to load preview.
              {active.error instanceof Error
                ? ` ${active.error.message}`
                : null}
            </div>
          ) : active.data?.status === "missing" ? (
            <p className="text-sm text-muted-foreground">
              N/A — file does not exist on {side}.
            </p>
          ) : active.data?.status === "binary" ? (
            <p className="text-sm text-muted-foreground">
              N/A — binary file, cannot render as Markdown.
            </p>
          ) : (
            <Markdown owner={owner} repo={repo} className="markdown-preview">
              {active.data?.content ?? ""}
            </Markdown>
          )}
        </div>
      </div>
    </div>
  );
}

function SideButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "px-2 py-1 first:border-r",
        active
          ? "bg-accent text-accent-foreground"
          : "bg-background hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
