// Modal dialog that hosts the /lh-issue-create flow in its own terminal, front and center.
// Filing an issue is the most important flow, so it runs in a focused overlay (dimmed backdrop)
// rather than as a tab in the bottom terminal pane — which stays the "work area". The terminal is
// a reused TerminalView, so closing the modal unmounts it, closing its WebSocket and killing the
// PTY server-side (same teardown as closing a bottom tab).
//
// Close affordance: the × button (and a shell exit) close the modal. Esc is deliberately NOT bound
// to close — the terminal runs Claude Code, where Esc interrupts the running turn; a global Esc
// handler would hijack that and tear down the session mid-flow.

import { X } from "lucide-react";
import { TerminalView } from "@/components/terminal-view";
import { Button } from "@/components/ui/button";

// Command typed into the spawned shell. `lh issue new` launches the /lh-issue-create skill in a
// Claude session recorded as kind=issue-create (#299) — so the filing session is linked to the
// created issue and resumable later — instead of bare `claude "/lh-issue-create"` (which left no
// recorded session). `--repo` scopes it to the repo in view; omitted when unknown so `lh` falls
// back to cwd resolution (the previous behaviour). owner/name is a safe shell token (a registered
// repo full name: `[\w.-]+/[\w.-]+`), so the literal needs no escaping; guarded below regardless.
function createIssueCommand(repo: string): string {
  const safe = /^[\w.-]+\/[\w.-]+$/.test(repo);
  return safe ? `lh issue new --repo ${repo}` : "lh issue new";
}

export function CreateIssueModal({
  repo,
  onClose,
}: {
  // "owner/name" of the repo whose base dir becomes the terminal cwd, or "" for $HOME. `lh issue
  // new` files into this repo (via --repo, else cwd), mirroring the previous bottom-tab behaviour.
  repo: string;
  onClose: () => void;
}) {
  return (
    // Front overlay with a dimmed backdrop. No backdrop-click-to-close: an accidental outside click
    // must not kill an in-progress filing session — closing is intentional (× or shell exit) only.
    // The dialog is vertically centered (not stretched) so its height comes from the definite
    // h-[min(36rem,100%)] below rather than always filling the viewport.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New issue"
        // Stable mid size via a *definite* height (not just a min-height): the embedded terminal
        // sizes to its container with `h-full` (height:100%), which only resolves against an
        // ancestor whose height is definite. A min-height alone leaves the flex chain indefinite,
        // so `h-full` collapses to the terminal's intrinsic content height and the dialog shows a
        // large empty gap below it (#317). A concrete height makes the chain resolve so the
        // terminal fills the body. min(36rem,100%) caps to the available height, so a viewport
        // shorter than 36rem shrinks to fit instead of overflowing.
        className="flex h-[min(36rem,100%)] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
      >
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">New issue</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close new issue"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 bg-background px-2 py-1">
          <TerminalView
            repo={repo}
            command={createIssueCommand(repo)}
            active
            onExit={onClose}
          />
        </div>
      </div>
    </div>
  );
}
