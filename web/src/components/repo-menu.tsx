// Overflow menu for the repo detail header. Holds infrequent repo-level actions
// — currently Archive / Unarchive — behind a "…" trigger so they don't crowd the
// header. Archiving routes back home (the repo leaves the active sidebar list);
// unarchiving stays put.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRepo, useSetRepoArchived } from "@/queries/repos";

export function RepoMenu({ owner, repo }: { owner: string; repo: string }) {
  const navigate = useNavigate();
  const { data } = useRepo(owner, repo);
  const setArchived = useSetRepoArchived(owner, repo);

  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click or Escape (native dropdown dismissal). The
  // confirm dialog manages its own Escape, so only bind while the menu is open.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Gate the action on a resolved repo: until the fetch lands, `archived` is
  // unknown and acting on the default would let the user e.g. "Archive" an
  // already-archived repo. `loaded` disables the trigger until then.
  const loaded = data !== undefined;
  const archived = data?.archived ?? false;

  async function onConfirm() {
    try {
      await setArchived.mutateAsync(!archived);
    } catch {
      // Failure is surfaced via setArchived.error in the dialog; keep it open
      // and avoid an unhandled rejection from this event handler.
      return;
    }
    setConfirming(false);
    // Archiving removes the repo from the active sidebar list; send the user
    // back home so they aren't left on a now-archived dashboard.
    if (!archived) navigate({ to: "/" });
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Repository actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!loaded}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="size-4" />
      </Button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-40 rounded-md border bg-background p-1 shadow-md"
        >
          <button
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setOpen(false);
              setConfirming(true);
            }}
          >
            {archived ? (
              <ArchiveRestore className="size-4" />
            ) : (
              <Archive className="size-4" />
            )}
            {archived ? "Unarchive" : "Archive"}
          </button>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmArchiveDialog
          owner={owner}
          repo={repo}
          archived={archived}
          pending={setArchived.isPending}
          error={setArchived.error ? String(setArchived.error) : null}
          onConfirm={onConfirm}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

function ConfirmArchiveDialog({
  owner,
  repo,
  archived,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  owner: string;
  repo: string;
  archived: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const action = archived ? "Unarchive" : "Archive";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${action} repository`}
        className="flex w-full max-w-md flex-col rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">
          {action} {owner}/{repo}?
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          {archived
            ? "アーカイブを解除すると、このリポジトリは再びサイドバーの一覧に表示されます。"
            : "アーカイブするとサイドバーの一覧から外れます。いつでも解除できます。"}
        </p>
        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            キャンセル
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "実行中…" : action}
          </Button>
        </div>
      </div>
    </div>
  );
}
