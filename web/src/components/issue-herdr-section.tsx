// Issue-detail Agents section for the New Issue Herdr pane captured at creation time (#670).
// Deliberately does not read terminal/sessions: linked-PR worktree agents belong on PR surfaces,
// not on the issue detail page (#838). Renders nothing when the issue has no captured pane.

import { Bot, Loader2, Terminal } from "lucide-react";
import type { Issue } from "@/api/types";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { useFocusHerdrAgent } from "@/queries/terminal";

export function IssueHerdrSection({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const paneId = issue.herdr_pane?.pane_id;
  const focus = useFocusHerdrAgent();
  const { showError } = useToast();
  if (!paneId) return null;

  const sessionName = issue.herdr_pane?.session_name ?? paneId;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Agents</h2>
      </div>
      <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
        <Bot className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={sessionName}>
            {sessionName}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            New Issue pane
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          title="Open the terminal that created this issue in Herdr"
          aria-label="Open in Herdr"
          disabled={focus.isPending}
          onClick={() =>
            focus.mutate(
              { repo: `${owner}/${repo}`, paneId },
              {
                onError: (e) =>
                  showError(
                    e instanceof Error ? e.message : "Failed to open in Herdr.",
                  ),
              },
            )
          }
        >
          {focus.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Terminal className="size-4" />
          )}
          Open in Herdr
        </Button>
      </div>
    </section>
  );
}
