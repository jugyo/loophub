// "New issue" button. Issues are filed by an AI (Claude Code etc.) via the /lh-issue-create
// skill, not by hand — so the button opens an embedded terminal tab running that skill in the
// current repo. The skill, with no arguments, interviews the user, checks for duplicates, shapes
// the Goal and acceptance criteria, then files the issue and returns its number and URL.
// The backend create API (useCreateIssue) stays for the skill/CLI to use.

import { Plus } from "lucide-react";
import { useTerminal } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";
import { useCurrentRepo } from "@/lib/use-current-repo";

// Command typed into the spawned shell. The skill's slash form starts a Claude session in
// question mode (no arguments). It needs no shell escaping — it is a fixed literal.
const CREATE_ISSUE_COMMAND = 'claude "/lh-issue-create"';

export function CreateIssueButton() {
  const { openTerminal } = useTerminal();
  // Run in the repo currently in view so the skill resolves the target repo from cwd.
  const repo = useCurrentRepo() ?? "";

  return (
    <Button
      size="sm"
      onClick={() =>
        openTerminal({
          command: CREATE_ISSUE_COMMAND,
          repo,
          label: "New issue",
        })
      }
    >
      <Plus className="size-4" />
      New issue
    </Button>
  );
}
