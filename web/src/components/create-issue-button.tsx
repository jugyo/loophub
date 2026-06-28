// "New issue" button. Issues are filed by an AI (Claude Code etc.) via the /lh-issue-create
// skill, not by hand — so the button opens a focused modal dialog (CreateIssueModal) running that
// skill in a terminal scoped to the current repo. Filing is the most important flow, so it gets a
// front overlay rather than a tab in the bottom terminal pane (which stays the "work area"). The
// backend create API (useCreateIssue) stays for the skill/CLI to use.

import { Plus } from "lucide-react";
import { useState } from "react";
import { CreateIssueModal } from "@/components/create-issue-modal";
import { Button } from "@/components/ui/button";
import { useCurrentRepo } from "@/lib/use-current-repo";

export function CreateIssueButton() {
  const [open, setOpen] = useState(false);
  // Run in the repo currently in view so the skill resolves the target repo from cwd.
  const repo = useCurrentRepo() ?? "";

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        New issue
      </Button>
      {open && <CreateIssueModal repo={repo} onClose={() => setOpen(false)} />}
    </>
  );
}
