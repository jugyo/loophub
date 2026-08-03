// Debug data view for a PR (#248). A discreet "…" overflow menu next to the PR title opens a
// full-size, read-only modal that dumps everything a PR can be reached from — raw DB rows, git
// facts, reviews/comments/notes, related events, and the dev session — as scannable per-section
// tables. CopyButton copies the full dump as JSON for pasting into bug reports.
// Inspection only: no edits, no writes. The dump is fetched lazily (usePullDebug `enabled`) the
// first time the modal opens, so the (git-fanning) call never runs on a normal page view.

import { Loader2, MoreHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { DebugDataView } from "@/components/pull-debug-view";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { useArchivePull, usePullDebug } from "@/queries/pulls";

export function PullDebugMenu({
  owner,
  repo,
  number,
  onArchived = () => {},
}: {
  owner: string;
  repo: string;
  number: number;
  onArchived?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const archivePull = useArchivePull(owner, repo, number);
  const { showError } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const archiveDialogBackdropDismiss = useBackdropDismiss(() => {
    if (!archivePull.isPending) setConfirmingArchive(false);
  });

  // Close the menu on outside click or Escape (native dropdown dismissal). The modal manages
  // its own Escape, so only bind this while the menu (not the modal) is open.
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div
      ref={containerRef}
      data-debug-component="PullDebugMenu"
      className="relative inline-block"
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="PR actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <MoreHorizontal className="size-4" />
      </Button>

      {menuOpen ? (
        <div
          data-debug-component="PullDebugMenuContent"
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-48 rounded-md border bg-background p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setMenuOpen(false);
              setModalOpen(true);
            }}
          >
            View debug data
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setMenuOpen(false);
              setConfirmingArchive(true);
            }}
          >
            Archive
          </button>
        </div>
      ) : null}

      {confirmingArchive ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
          {...archiveDialogBackdropDismiss}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Archive PR #${number}?`}
            className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Archive PR #{number}?</h2>
            <p className="mt-3 text-sm text-muted-foreground">
              This hides the PR from active lists while preserving its history
              and link to the issue.
            </p>
            {archivePull.error ? (
              <p className="mt-3 text-sm text-destructive">
                {archivePull.error instanceof Error
                  ? archivePull.error.message
                  : "Archive failed"}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={archivePull.isPending}
                onClick={() => setConfirmingArchive(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={archivePull.isPending}
                onClick={() =>
                  archivePull.mutate(undefined, {
                    onSuccess: onArchived,
                    onError: (error) =>
                      showError(errorMessage(error, "Archive failed")),
                  })
                }
              >
                {archivePull.isPending ? "Archiving…" : "Archive"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {modalOpen ? (
        <DebugDataModal
          owner={owner}
          repo={repo}
          number={number}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
    </div>
  );
}

function DebugDataModal({
  owner,
  repo,
  number,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  onClose: () => void;
}) {
  const query = usePullDebug(owner, repo, number, true);
  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const data = query.data as Record<string, unknown> | undefined;
  const json = data ? JSON.stringify(data, null, 2) : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-4"
      {...backdropDismiss}
    >
      <div
        data-debug-component="DebugDataModal"
        role="dialog"
        aria-modal="true"
        aria-label={`Debug data for PR #${number}`}
        className="flex w-full max-w-6xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">
            Debug data — {owner}/{repo} #{number}
          </h2>
          <div className="flex items-center gap-1">
            {json ? <CopyButton value={json} label="Copy JSON" /> : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close debug data"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {query.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading debug data…
            </div>
          ) : query.isError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              Failed to load debug data.
              {query.error instanceof Error ? ` ${query.error.message}` : null}
            </div>
          ) : data ? (
            <DebugDataView data={data} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
