// Agent badge shown next to a PR reference only while a herdr terminal is actually
// running for that PR's worktree (#579) — invisible (renders null) otherwise, so it never
// implies a session that isn't there. Extracted from dashboard-rows.tsx (#609) so the
// issue-detail linked-PR row can show the same badge. Reuses the same terminal/sessions poll
// the sidebar section already runs (useHerdrSessions, #495): one shared 15s-interval query for
// every row on the page, not one herdr shellout per row. Clicking switches herdr's focus to
// that agent's pane via terminal/focusAgent (#578's `herdr agent focus`, reused here) instead
// of launching a new terminal.

import { Bot } from "lucide-react";
import type {
  HerdrPullWorkspace,
  HerdrRepoSessions,
  HerdrSessions,
} from "@/api/types";
import { useToast } from "@/components/toast";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

/**
 * The herdr session group and agent pane running `owner/repo`'s PR #`pull`, or null when
 * herdr reports none. Shared by the badge below and the PR-detail Herdr section (#609) so
 * both resolve "is a herdr terminal running this PR" the same way. Guarded against a
 * non-array `repos` (the RPC mock returns {} for unstubbed methods).
 */
export function findPullHerdrWorkspace(
  data: HerdrSessions | undefined,
  repo: string,
  pull: number,
): { group: HerdrRepoSessions; workspace: HerdrPullWorkspace } | null {
  const groups = Array.isArray(data?.repos) ? data.repos : [];
  for (const group of groups) {
    if (group.repo !== repo) continue;
    const workspace = group.pull_workspaces.find((w) => w.pull === pull);
    if (workspace) return { group, workspace };
  }
  return null;
}

export function isPullHerdrWorking(
  data: HerdrSessions | undefined,
  repo: string,
  pull: number,
): boolean {
  const groups = Array.isArray(data?.repos) ? data.repos : [];
  for (const group of groups) {
    if (group.repo !== repo) continue;
    const agents = Array.isArray(group.agents) ? group.agents : [];
    if (agents.some((agent) => agent.pull === pull && agent.status === "working"))
      return true;
    const workspaces = Array.isArray(group.pull_workspaces)
      ? group.pull_workspaces
      : [];
    return workspaces.some((workspace) => workspace.pull === pull && workspace.status === "working");
  }
  return false;
}

export function HerdrBadge({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: number;
}) {
  const { data } = useHerdrSessions();
  const workspace = findPullHerdrWorkspace(
    data,
    `${owner}/${repo}`,
    pull,
  )?.workspace;
  const focus = useFocusHerdrAgent();
  const { showError } = useToast();
  if (!workspace) return null;
  return (
    <button
      type="button"
      title="Focus the running agent pane"
      aria-label={`Focus agent pane for PR #${pull}`}
      disabled={focus.isPending}
      onClick={() =>
        focus.mutate(
          { repo: `${owner}/${repo}`, paneId: workspace.pane_id },
          {
            onError: (e) =>
              showError(
                e instanceof Error
                  ? e.message
                  : "Failed to focus the agent pane.",
              ),
          },
        )
      }
      className={cn(
        badgeVariants({ tone: "unknown" }),
        "shrink-0 gap-1 rounded-sm border-zinc-400 bg-zinc-500 font-mono text-zinc-50 hover:opacity-80 disabled:pointer-events-none disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300",
      )}
    >
      <Bot className="size-3" />
      {workspace.status ? (
        <span className="text-zinc-300 dark:text-zinc-500">
          {workspace.status}
        </span>
      ) : null}
    </button>
  );
}
