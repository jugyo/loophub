// PR-detail sidebar section (#609): the herdr session running this PR's worktree, with a
// Focus button that switches herdr's focus to that agent's pane (terminal/focusAgent, #578 —
// same action as the issue-list Herdr badge, #579). Renders nothing when herdr reports no
// session for the PR, so the sidebar never implies a terminal that isn't there. Reuses the
// shared terminal/sessions poll (useHerdrSessions, #495) — no extra herdr shellout per page.

import { Terminal } from "lucide-react";
import { findPullHerdrWorkspace } from "@/components/herdr-badge";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

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
  // Hide on error too (same as the sidebar Agents section): react-query keeps the last
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
  // pane (HerdrAgent.id is the pane id whenever herdr reported one — see
  // sidebar-herdr-sessions.tsx's agentReadTarget). Missing match (synthetic id) just drops
  // the name line; the session name and status still identify the terminal.
  const agent = group.agents.find((a) => a.id === workspace.pane_id);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Herdr</h2>
      <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
        <Terminal className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={group.session_name}>
            {group.session_name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {agent ? `${agent.name} · ` : ""}
            {workspace.status}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          title="Focus the running Herdr terminal"
          disabled={focus.isPending}
          onClick={() =>
            focus.mutate(
              { repo: `${owner}/${repo}`, paneId: workspace.pane_id },
              {
                onError: (e) =>
                  showError(
                    e instanceof Error
                      ? e.message
                      : "Failed to focus the Herdr terminal.",
                  ),
              },
            )
          }
        >
          Focus
        </Button>
      </div>
    </section>
  );
}
