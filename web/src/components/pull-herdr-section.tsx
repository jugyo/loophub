// PR-detail sidebar section (#609): the herdr session running this PR's worktree, with an
// Open in Herdr button that switches herdr's focus to that agent's pane (terminal/focusAgent,
// #578 — same action as the issue-list Herdr badge, #579). Renders nothing when herdr reports no
// session for the PR, so the sidebar never implies a terminal that isn't there. Reuses the
// shared terminal/sessions poll (useHerdrSessions, #495) — no extra herdr shellout per page.

import { Bot, Terminal } from "lucide-react";
import { HerdrAgentInput } from "@/components/herdr-agent-input";
import {
  findPullHerdrWorkspace,
  herdrWorkspaceBadgeIconClass,
} from "@/components/herdr-badge";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

function statusTextClass(status: string): string {
  switch (status) {
    case "blocked":
      return "text-red-500";
    case "working":
      return "text-yellow-500";
    case "done":
      return "text-blue-500";
    case "idle":
      return "text-green-500";
    default:
      return "text-muted-foreground";
  }
}

export function PullHerdrSection({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: number;
}) {
  const { data, isError } = useHerdrSessions();
  const focus = useFocusHerdrAgent();
  const { showError } = useToast();
  // Hide on error too: react-query keeps the last
  // successful data across a failed refetch, and a stale session is worse than none while
  // the server is unreachable.
  const found = findPullHerdrWorkspace(
    isError ? undefined : data,
    `${owner}/${repo}`,
    pull,
  );
  if (!found) return null;
  const { group, workspace } = found;
  // The workspace only carries the pane id; the agent list has the display name for that
  // pane (HerdrAgent.id is the pane id whenever herdr reported one). Missing match drops
  // the name line; the session name and status still identify the terminal.
  const agent = group.agents.find((a) => a.id === workspace.pane_id);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Agents</h2>
      </div>
      <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
        <div className="flex items-center gap-2">
          <Bot
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              herdrWorkspaceBadgeIconClass(workspace.status),
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium" title={group.session_name}>
              {group.session_name}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {agent ? `${agent.name} · ` : ""}
              <span className={statusTextClass(workspace.status)}>
                {workspace.status}
              </span>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            title="Open the running agent pane in Herdr"
            aria-label="Open in Herdr"
            disabled={focus.isPending}
            onClick={() =>
              focus.mutate(
                { repo: `${owner}/${repo}`, paneId: workspace.pane_id },
                {
                  onError: (e) =>
                    showError(
                      e instanceof Error
                        ? e.message
                        : "Failed to open in Herdr.",
                    ),
                },
              )
            }
          >
            <Terminal className="size-4" />
            Open in Herdr
          </Button>
        </div>
        <HerdrAgentInput
          repo={`${owner}/${repo}`}
          pull={pull}
          paneId={workspace.pane_id}
          className="border-t pt-3"
        />
      </div>
    </section>
  );
}
