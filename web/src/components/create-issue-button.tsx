// "New issue" launcher. Issues are filed by an AI (Claude Code etc.) via the /lh-issue-create
// skill, not by hand — so the button launches that skill as a Herdr session scoped to the repo
// currently in view. The backend create API (useCreateIssue) stays for the skill/CLI to use.
//
// It is rendered from the app shell (app-layout.tsx) as a fixed floating button so issues can be
// filed from any repo-scoped screen. The skill needs a target repo (resolved from cwd), so it
// renders nothing on non-repo screens (home, archived) where useCurrentRepo() is null.

import { Plus } from "lucide-react";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";
import { useCurrentRepo } from "@/lib/use-current-repo";

// Unlike Issue/PR/Resume launches (#497), there is no issue number yet to make the herdr agent
// name unique — the issue doesn't exist until the launched session files it. A random suffix
// keeps consecutive New Issue launches from colliding on the same agent name (`agent_name_taken`,
// #501); unlike a Date.now() timestamp, it can't collide even when two launches land in the same
// millisecond.
function launchSuffix(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

export function CreateIssueButton() {
  // Run in the repo currently in view so the skill resolves the target repo from cwd.
  const repo = useCurrentRepo();
  const { launchTerminal } = useTerminalLauncher();
  // No repo in view (home / archived) → nothing to file against, so render nothing.
  if (!repo) return null;

  return (
    <Button
      size="icon"
      aria-label="New issue"
      title="New issue"
      onClick={() =>
        launchTerminal({
          repo,
          label: `New issue - ${launchSuffix()}`,
          workflow: "issue-create",
        })
      }
      style={{ bottom: "1rem" }}
      className="fixed right-4 z-50 h-14 w-14 rounded-full shadow-lg"
    >
      <Plus className="size-6" />
    </Button>
  );
}
