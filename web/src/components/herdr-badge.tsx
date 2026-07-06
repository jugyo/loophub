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
  HerdrIssueWorkspace,
  HerdrPullWorkspace,
  HerdrRepoSessions,
  HerdrSessions,
} from "@/api/types";
import { useToast } from "@/components/toast";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

/**
 * The herdr session group and agent pane running `owner/repo`'s PR `#pull`, or null when
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

/**
 * The herdr session group and agent pane working `owner/repo`'s issue `#issue`, or null when
 * herdr reports none. Issue-keyed counterpart of findPullHerdrWorkspace (#821), backing the
 * issue-detail Agents section. Guarded against a non-array `repos` / `issue_workspaces` (the RPC
 * mock returns {} for unstubbed methods; older payloads may omit the field).
 */
export function findIssueHerdrWorkspace(
  data: HerdrSessions | undefined,
  repo: string,
  issue: number,
): { group: HerdrRepoSessions; workspace: HerdrIssueWorkspace } | null {
  const groups = Array.isArray(data?.repos) ? data.repos : [];
  for (const group of groups) {
    if (group.repo !== repo) continue;
    const workspaces = Array.isArray(group.issue_workspaces)
      ? group.issue_workspaces
      : [];
    const workspace = workspaces.find((w) => w.issue === issue);
    if (workspace) return { group, workspace };
  }
  return null;
}

/**
 * Reused by issue/pull detail rows to render a working-state dot/word path.
 */
export function isPullHerdrWorking(
  data: HerdrSessions | undefined,
  repo: string,
  pull: number,
): boolean {
  const groups = Array.isArray(data?.repos) ? data.repos : [];
  for (const group of groups) {
    if (group.repo !== repo) continue;
    const agents = Array.isArray(group.agents) ? group.agents : [];
    if (
      agents.some((agent) => agent.pull === pull && agent.status === "working")
    )
      return true;
    const workspaces = Array.isArray(group.pull_workspaces)
      ? group.pull_workspaces
      : [];
    return workspaces.some(
      (workspace) => workspace.pull === pull && workspace.status === "working",
    );
  }
  return false;
}

export function herdrWorkspaceBadgeIconClass(
  status?: string,
): "animate-bot-bounce" | "animate-bot-wobble" | "" {
  switch (status) {
    case "working":
      return "animate-bot-wobble";
    case "blocked":
      return "animate-bot-bounce";
    default:
      return "";
  }
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
      title="Focus the running terminal"
      aria-label={`Focus terminal for PR #${pull}`}
      disabled={focus.isPending}
      onClick={() =>
        focus.mutate(
          { repo: `${owner}/${repo}`, paneId: workspace.pane_id },
          {
            onError: (e) =>
              showError(
                e instanceof Error ? e.message : "Failed to focus terminal.",
              ),
          },
        )
      }
      className={cn(
        badgeVariants({ tone: "unknown" }),
        // Terminal-flavored look, not the pill shape the rest of the badges use: a near-square
        // corner radius and a gray zinc palette per theme (mid-gray in light, near-black in
        // dark) so it reads as a little terminal chip rather than another status pill.
        "shrink-0 gap-1 rounded-sm border-zinc-400 bg-zinc-500 font-mono text-zinc-50 hover:opacity-80 disabled:pointer-events-none disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300",
      )}
    >
      <Bot
        className={cn("size-3", herdrWorkspaceBadgeIconClass(workspace.status))}
      />
      {workspace.status ? (
        <span className="text-zinc-300 dark:text-zinc-500">
          {workspace.status}
        </span>
      ) : null}
    </button>
  );
}
