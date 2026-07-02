// "New issue" launcher. Issues are filed by an AI (Claude Code etc.) via the /lh-issue-create
// skill, not by hand — so the button opens a bottom-right dock (CreateIssueModal) running that
// skill in a terminal scoped to the current repo. The dock sits in the corner like a chat box with
// no backdrop, so the screen behind it stays usable while a filing session runs. The backend create
// API (useCreateIssue) stays for the skill/CLI to use.
//
// It is rendered from the app shell (app-layout.tsx) as a fixed floating button so issues can be
// filed from any repo-scoped screen. The skill needs a target repo (resolved from cwd), so it
// renders nothing on non-repo screens (home, archived) where useCurrentRepo() is null — which also
// tears down any open dock (and its PTY) on navigation away from a repo, as before.

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { CreateIssueModal } from "@/components/create-issue-modal";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { useTerminalLaunchConfig } from "@/queries/terminal";

// Unlike Issue/PR/Resume launches (#497), there is no issue number yet to make the herdr agent
// name unique — the issue doesn't exist until the launched session files it. A random suffix
// (same technique as terminal-pane.tsx's newId()) keeps consecutive New Issue launches from
// colliding on the same agent name (`agent_name_taken`, #501); unlike a Date.now() timestamp, it
// can't collide even when two launches land in the same millisecond.
function launchSuffix(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

export function CreateIssueButton() {
  // `open` mounts the dock (and its terminal/PTY); `minimized` collapses it to a header bar while
  // keeping the terminal mounted so the running session survives.
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // Run in the repo currently in view so the skill resolves the target repo from cwd.
  const repo = useCurrentRepo();
  const launchConfig = useTerminalLaunchConfig();
  const { launchTerminal } = useTerminalLauncher();
  // Leaving every repo (home / archived) unmounts the dock and kills its PTY. Reset the open/minimized
  // flags too, otherwise they stay set and the dock auto-resurrects with a *brand-new* session — a
  // hidden one if it was minimized — the next time a repo comes into view, without the user asking.
  useEffect(() => {
    if (!repo) {
      setOpen(false);
      setMinimized(false);
    }
  }, [repo]);
  // No repo in view (home / archived) → nothing to file against, so render nothing.
  if (!repo) return null;
  const builtin =
    launchConfig.isSuccess && launchConfig.data.backend === "builtin";
  const herdr = launchConfig.isSuccess && launchConfig.data.backend === "herdr";

  // Close destroys the dock: unmounting CreateIssueModal unmounts TerminalView, which closes the
  // WebSocket and kills the PTY server-side.
  const close = () => {
    setOpen(false);
    setMinimized(false);
  };

  return (
    <>
      {/* Floating action button: a circular icon-only launcher, bottom-right, that sticks its bottom
          just above the bottom terminal's top edge (#384). --lh-term-reserve (published by
          terminal-pane.tsx) is the terminal's footprint plus a 12px breathing gap as a viewport-bottom
          offset, so the launcher rises with the terminal and rests a margin above it instead of being
          covered. clamp() keeps the old bottom-right resting spot when the terminal is collapsed (floor
          3.5rem) and stops a maximized terminal (var ≈ 100dvh) from pushing the button off the top of
          the viewport (ceiling 100dvh − 5rem). z-50 (> the terminal pane's z-40) lets it float over an
          expanded terminal. Icon-only, so aria-label/title name it. Hidden once the dock is mounted —
          the dock (or its minimized bar) occupies this spot. */}
      {!open && (
        <Button
          size="icon"
          aria-label="New issue"
          title="New issue"
          disabled={!launchConfig.isSuccess}
          onClick={() =>
            herdr
              ? launchTerminal({
                  repo,
                  label: `New issue - ${launchSuffix()}`,
                  workflow: "issue-create",
                })
              : builtin
                ? setOpen(true)
                : null
          }
          style={{
            bottom:
              "clamp(3.5rem, var(--lh-term-reserve, 0px), calc(100dvh - 5rem))",
          }}
          className="fixed right-4 z-50 h-14 w-14 rounded-full shadow-lg"
        >
          <Plus className="size-6" />
        </Button>
      )}
      {open && builtin && (
        <CreateIssueModal
          repo={repo}
          minimized={minimized}
          onMinimize={() => setMinimized(true)}
          onRestore={() => setMinimized(false)}
          onClose={close}
        />
      )}
    </>
  );
}
