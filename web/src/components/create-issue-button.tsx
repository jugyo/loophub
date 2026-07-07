// "New issue" launcher. Issues are filed by an AI (Claude Code etc.) via the /lh-issue-create
// skill, not by hand, so the button launches that skill as a Herdr session scoped to the repo
// whose issue list is in view. The backend create API (useCreateIssue) stays for the skill/CLI
// to use.

import { Plus } from "lucide-react";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";

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

export function CreateIssueButton({ repo }: { repo: string }) {
  const { launchTerminal } = useTerminalLauncher();

  return (
    <Button
      aria-label="New issue"
      title="New issue"
      onClick={() =>
        launchTerminal({
          repo,
          label: `New issue - ${launchSuffix()}`,
          workflow: "issue-create",
        })
      }
    >
      <Plus className="size-4" />
      New issue
    </Button>
  );
}
