// "New issue" button. Issues are filed by an AI (Claude Code etc.) via the /lh-issue-create
// skill, not by hand — so the button opens a focused modal dialog (CreateIssueModal) running that
// skill in a terminal scoped to the current repo. Filing is the most important flow, so it gets a
// front overlay rather than a tab in the bottom terminal pane (which stays the "work area"). The
// backend create API (useCreateIssue) stays for the skill/CLI to use.
//
// It lives in the app-shell top bar (app-layout.tsx) so issues can be filed from any repo-scoped
// screen, not just the repo dashboard. The skill needs a target repo (resolved from cwd), so the
// button renders nothing on non-repo screens (home, archived) where useCurrentRepo() is null.

import { Plus } from "lucide-react";
import { useState } from "react";
import { CreateIssueModal } from "@/components/create-issue-modal";
import { Button } from "@/components/ui/button";
import { useCurrentRepo } from "@/lib/use-current-repo";

export function CreateIssueButton() {
  const [open, setOpen] = useState(false);
  // Run in the repo currently in view so the skill resolves the target repo from cwd.
  const repo = useCurrentRepo();
  // No repo in view (home / archived) → nothing to file against, so render nothing.
  if (!repo) return null;

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
