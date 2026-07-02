// Overflow menu for the repo detail header. Holds infrequent repo-level actions
// — Archive / Unarchive, Rename, and the PR-action toggle — behind a "…" trigger
// so they don't crowd the header. Archiving routes back home (the repo leaves the
// active sidebar list); unarchiving stays put. Renaming routes to the new URL.

import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Check,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MergeMode } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  useRenameRepo,
  useRepo,
  useRepoMergeMode,
  useSetRepoArchived,
  useSetRepoMergeMode,
} from "@/queries/repos";

export function RepoMenu({ owner, repo }: { owner: string; repo: string }) {
  const navigate = useNavigate();
  const { data } = useRepo(owner, repo);
  const setArchived = useSetRepoArchived(owner, repo);

  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
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

          <button
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setOpen(false);
              setRenaming(true);
            }}
          >
            <Pencil className="size-4" />
            Rename
          </button>

          <MergeModeSection owner={owner} repo={repo} />
        </div>
      ) : null}

      {renaming ? (
        <RenameRepoDialog
          owner={owner}
          repo={repo}
          onClose={() => setRenaming(false)}
        />
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

// #406: per-repo PR write-action toggle. The repo offers exactly one of the internal Merge button
// or "Create PR on GitHub" on every PR detail; this picks which. "Auto" clears the override so the
// choice follows whether the repo has a GitHub remote (the effective default is shown inline). The
// three options are mutually exclusive, rendered as a radio-style group with a check on the active
// one.
const MERGE_MODE_LABELS: Record<MergeMode, string> = {
  merge: "Merge",
  github_pr: "Create PR on GitHub",
};

function MergeModeSection({ owner, repo }: { owner: string; repo: string }) {
  const { data, isLoading } = useRepoMergeMode(owner, repo);
  const setMode = useSetRepoMergeMode(owner, repo);

  const current = data?.setting ?? null; // null = Auto
  const autoHint = data
    ? `follows remote — ${MERGE_MODE_LABELS[data.effective]}`
    : "";

  // value: "auto" | "merge" | "github_pr"; "auto" maps to a null setting.
  const options: { value: "auto" | MergeMode; label: string; hint?: string }[] =
    [
      { value: "auto", label: "Auto", hint: autoHint },
      { value: "merge", label: MERGE_MODE_LABELS.merge },
      { value: "github_pr", label: MERGE_MODE_LABELS.github_pr },
    ];

  return (
    <div className="mt-1 border-t pt-1">
      <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
        PR action
      </div>
      {options.map((o) => {
        const active = (current ?? "auto") === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            disabled={isLoading || setMode.isPending}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            onClick={() => {
              if (active) return;
              setMode.mutate(o.value);
            }}
          >
            <Check
              className={`size-4 shrink-0 ${active ? "" : "invisible"}`}
              aria-hidden="true"
            />
            <span className="flex flex-col">
              <span>{o.label}</span>
              {o.hint ? (
                <span className="text-xs text-muted-foreground">{o.hint}</span>
              ) : null}
            </span>
          </button>
        );
      })}
      {setMode.error ? (
        <p className="px-2 py-1 text-xs text-destructive">
          {String(setMode.error)}
        </p>
      ) : null}
    </div>
  );
}

// #485: rename the repo's owner/name. Worktree/dev-lock paths derive from the name, so the
// server refuses while worktrees exist under the current name — that error is surfaced here.
// On success, navigate to the repo's new URL (the old /r/:owner/:repo no longer resolves).
function RenameRepoDialog({
  owner,
  repo,
  onClose,
}: {
  owner: string;
  repo: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const rename = useRenameRepo(owner, repo);
  const [value, setValue] = useState(`${owner}/${repo}`);

  // Match the disabled Cancel button: no dismissal path (Escape/backdrop) while the
  // mutation is in flight, so the dialog can't vanish mid-rename.
  const pending = rename.isPending;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  const unchanged = value.trim() === `${owner}/${repo}`;

  async function onSubmit() {
    let updated: Awaited<ReturnType<typeof rename.mutateAsync>>;
    try {
      updated = await rename.mutateAsync(value.trim());
    } catch {
      // Surfaced via rename.error below; keep the dialog open.
      return;
    }
    onClose();
    const [newOwner, newRepo] = updated.full_name.split("/");
    navigate({
      to: "/r/$owner/$repo",
      params: { owner: newOwner, repo: newRepo },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={() => {
        if (!pending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Rename repository"
        className="flex w-full max-w-md flex-col rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">
          Rename {owner}/{repo}?
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          Changes the repository's owner/name in LoopHub. The local git folder
          is not moved. Renaming is refused while worktrees exist under the
          current name.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!unchanged && !rename.isPending) onSubmit();
          }}
        >
          <input
            type="text"
            aria-label="New repository name"
            className="mt-4 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          {rename.error ? (
            <p className="mt-3 text-sm text-destructive">
              {String(rename.error)}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={rename.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={rename.isPending || unchanged}>
              {rename.isPending ? "Working…" : "Rename"}
            </Button>
          </div>
        </form>
      </div>
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
            ? "Unarchiving this repository makes it appear in the sidebar list again."
            : "Archiving removes this repository from the sidebar list. You can unarchive it anytime."}
        </p>
        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Working…" : action}
          </Button>
        </div>
      </div>
    </div>
  );
}
