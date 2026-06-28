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

// Command typed into the spawned shell. The skill's slash form starts a Claude session in
// question mode (no arguments). It needs no shell escaping — it is a fixed literal.
const CREATE_ISSUE_COMMAND = 'claude "/lh-issue-create"';

export function CreateIssueModal({
  repo,
  onClose,
}: {
  // "owner/name" of the repo whose base dir becomes the terminal cwd, or "" for $HOME. The skill
  // resolves the target repo from cwd, mirroring the previous bottom-tab behaviour.
  repo: string;
  onClose: () => void;
}) {
  return (
    // Front overlay with a dimmed backdrop. No backdrop-click-to-close: an accidental outside click
    // must not kill an in-progress filing session — closing is intentional (× or shell exit) only.
    // The dialog is vertically centered (not stretched) so its height comes from min-h/max-h below
    // rather than always filling the viewport.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New issue"
        // Height floor + viewport cap so the dialog stays a stable mid size: min-h keeps it from
        // collapsing (the embedded terminal fits to its container and has no intrinsic height, so
        // without a floor the dialog would shrink to just the header), while max-h-full caps it to
        // the available height. min() ties the floor to 100% so a viewport shorter than 36rem can't
        // produce a min-height that exceeds (and overflows) the cap.
        className="flex max-h-full min-h-[min(36rem,100%)] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
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
            command={CREATE_ISSUE_COMMAND}
            active
            onExit={onClose}
          />
        </div>
      </div>
    </div>
  );
}
