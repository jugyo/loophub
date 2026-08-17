// "New issue" launcher. The button gives the agent the filing instructions directly.

import { Plus } from "lucide-react";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/queries/settings";
import { issueCreatePrompt } from "../../../core/workflow/issue-create-prompt.ts";

// Unlike Issue/PR/Resume launches (#497), there is no issue number yet to make the pane's label
// unique — the issue doesn't exist until the launched session files it, and the label is what
// LoopHub identifies the pane by. A random suffix keeps consecutive New Issue launches apart
// (#501); unlike a Date.now() timestamp, it can't collide even when two launches land in the same
// millisecond.
function launchSuffix(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

export function CreateIssueButton({
  repo,
  targetBranch,
  parentIssue,
  disabled = false,
}: {
  repo: string;
  targetBranch?: string;
  parentIssue?: number;
  disabled?: boolean;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const { data: settings } = useSettings();
  function launchIssue() {
    launchTerminal({
      repo,
      label: `New issue - ${launchSuffix()}`,
      workflow: "issue-create",
      prompt: issueCreatePrompt(
        settings?.workflowContractLanguage,
        parentIssue,
      ),
      ...(parentIssue ? { parentIssue } : {}),
      ...(targetBranch ? { targetBranch } : {}),
    });
  }

  return (
    <div
      data-debug-component="CreateIssueButton"
      className="inline-flex min-w-0 flex-col items-end"
    >
      <div className="inline-flex max-w-full">
        <Button
          aria-label="New issue"
          title="New issue"
          disabled={disabled}
          onClick={() => launchIssue()}
        >
          <Plus className="size-4" />
          <span>New issue</span>
        </Button>
      </div>
      {targetBranch ? (
        <span className="max-w-56 truncate text-xs font-normal text-muted-foreground">
          in {targetBranch}
        </span>
      ) : null}
    </div>
  );
}
