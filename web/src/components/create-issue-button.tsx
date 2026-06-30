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
import { Button } from "@/components/ui/button";
import { useCurrentRepo } from "@/lib/use-current-repo";

export function CreateIssueButton() {
  // `open` mounts the dock (and its terminal/PTY); `minimized` collapses it to a header bar while
  // keeping the terminal mounted so the running session survives.
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // Run in the repo currently in view so the skill resolves the target repo from cwd.
  const repo = useCurrentRepo();
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

  // Close destroys the dock: unmounting CreateIssueModal unmounts TerminalView, which closes the
  // WebSocket and kills the PTY server-side.
  const close = () => {
    setOpen(false);
    setMinimized(false);
  };

  return (
    <>
      {/* Floating action button: a circular icon-only launcher, bottom-right, clearing the
          always-present collapsed terminal bar (36px). A fixed offset, not --lh-term-reserve: that
          var grows to ~100dvh when the bottom terminal is maximized/dragged tall, which would push
          the launcher off the top of the viewport. z-50 (> the terminal pane's z-40) instead lets
          it float over an expanded terminal. Icon-only, so aria-label/title name it. Hidden once the
          dock is mounted — the dock (or its minimized bar) then occupies this spot. */}
      {!open && (
        <Button
          size="icon"
          aria-label="New issue"
          title="New issue"
          onClick={() => setOpen(true)}
          className="fixed right-4 bottom-14 z-50 h-14 w-14 rounded-full shadow-lg"
        >
          <Plus className="size-6" />
        </Button>
      )}
      {open && (
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
