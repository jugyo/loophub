// Bottom-right "mini chat box" that hosts the /lh-issue-create flow in its own terminal, like the
// Facebook / LinkedIn chat docks. Filing an issue is an important flow, but it must not block the
// rest of the app: there is no dimmed backdrop and the dock is anchored to the bottom-right corner,
// so the screen behind it stays fully clickable and scrollable while a filing session runs. The
// terminal is a reused TerminalView, so unmounting this component (Close) closes its WebSocket and
// kills the PTY server-side (same teardown as closing a bottom tab).
//
// Minimize vs Close: Minimize only collapses the body to its header bar via CSS (`hidden`) — the
// TerminalView stays mounted, so the running session survives and can be restored. Close unmounts
// the whole dock, which is the only path that tears down the PTY.
//
// Close affordance: the × button (and a shell exit) close the dock. Esc is deliberately NOT bound
// to close — the terminal runs Claude Code, where Esc interrupts the running turn; a global Esc
// handler would hijack that and tear down the session mid-flow.

import { ChevronUp, Minus, X } from "lucide-react";
import { useRef } from "react";
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
  minimized,
  onMinimize,
  onRestore,
  onClose,
}: {
  // "owner/name" of the repo whose base dir becomes the terminal cwd, or "" for $HOME. `lh issue
  // new` files into this repo (via --repo, else cwd), mirroring the previous bottom-tab behaviour.
  repo: string;
  // Collapsed to the header bar only. The terminal stays mounted (PTY alive) — `hidden` just hides
  // the body — so restoring brings the same running session back.
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  // Freeze the repo at mount: it is the repo the spawned PTY actually files into (TerminalView
  // likewise captures `repo` once at mount and ignores later changes). The dock is non-blocking, so
  // the user can navigate to a *different* repo while it runs; the `repo` prop then changes but the
  // running session does not. Showing the captured repo keeps the header honest about which repo
  // this session targets, instead of silently appearing to follow the current view.
  const sessionRepo = useRef(repo).current;
  const title = sessionRepo ? `New issue · ${sessionRepo}` : "New issue";

  return (
    // Bottom-right dock. No backdrop and no `inset-0`: the screen behind stays interactive. The dock
    // sticks its bottom to the bottom terminal's top edge with a margin, just like the floating
    // launcher (#384/#398): --lh-term-reserve (published by terminal-pane.tsx) is the terminal's
    // footprint plus a 12px breathing gap; + 0.5rem widens that so the dock visibly clears the
    // terminal top (≈20px) instead of overlapping it. clamp() keeps the old bottom-right resting spot
    // when the terminal is collapsed (floor 3.5rem) and, when the terminal is maximized (var ≈ 100dvh),
    // caps the rise at a ceiling that still leaves the dock's minimum height (12rem) plus a 2rem top
    // margin on screen — there the dock degrades to overlapping the terminal (z-50 > z-40) rather than
    // being shoved off the top of the viewport. The expanded height shrinks with the terminal in step
    // (below), so the body stays fully on screen while the bottom rides the terminal up.
    <div
      className="fixed right-4 z-50"
      style={{
        bottom:
          "clamp(3.5rem, calc(var(--lh-term-reserve, 0px) + 0.5rem), calc(100dvh - 14rem))",
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        // Expanded width is unchanged (56rem); the height now clamps against the terminal footprint so
        // the dock never extends past the top of the viewport as it rides the terminal up: the middle
        // term `100dvh − var − 2.5rem` pins the dock top at ≈100dvh − 2rem (its bottom is var + 0.5rem),
        // bounded below by a 12rem floor (so a maximized terminal can't crush it to nothing) and above
        // by the original 36rem. A *definite* height (clamp resolves to one — not a min-height) keeps
        // the #317 fix: the embedded terminal sizes with `h-full`, which only resolves against a
        // definite-height ancestor; a min-height alone collapses it to its intrinsic content and leaves
        // a gap. Minimized collapses to a compact header pill (narrow width + h-auto) so the dock stops
        // covering the bottom terminal pane's right side, like a real chat-box minimize.
        className={`flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl ${
          minimized
            ? "h-auto w-[min(20rem,calc(100dvw-2rem))]"
            : "h-[clamp(12rem,calc(100dvh_-_var(--lh-term-reserve,0px)_-_2.5rem),36rem)] w-[min(56rem,calc(100dvw-2rem))]"
        }`}
      >
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          {minimized ? (
            // While collapsed the title bar doubles as the restore affordance (chat-box style). Its
            // visible text is its accessible name; the explicit "Restore new issue" stays on the
            // chevron so the two restore controls don't share one duplicate aria-label.
            <button
              type="button"
              onClick={onRestore}
              className="min-w-0 flex-1 truncate text-left text-sm font-semibold"
            >
              {title}
            </button>
          ) : (
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title}
            </h2>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                minimized ? "Restore new issue" : "Minimize new issue"
              }
              onClick={minimized ? onRestore : onMinimize}
            >
              {minimized ? (
                <ChevronUp className="size-4" />
              ) : (
                <Minus className="size-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close new issue"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>
        {/* `hidden` (not unmounted) while minimized: the TerminalView keeps its WebSocket/PTY, so
            the running filing session survives a minimize/restore cycle. `active` flips with the
            visibility so the terminal refits when restored from its 0-sized hidden state. */}
        <div
          className={
            minimized ? "hidden" : "min-h-0 flex-1 bg-background px-2 py-1"
          }
        >
          <TerminalView
            repo={repo}
            command={createIssueCommand(repo)}
            active={!minimized}
            onExit={onClose}
          />
        </div>
      </div>
    </div>
  );
}
