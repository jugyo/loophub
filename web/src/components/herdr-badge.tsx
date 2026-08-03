// Shared helpers for resolving herdr workspaces tied to a PR. Linked PR rows and PR detail
// surfaces reuse this so they agree on which pane/status belongs to a PR without shelling out per row.

import type {
  HerdrAgent,
  HerdrPullWorkspace,
  HerdrRepoSessions,
  HerdrSessions,
} from "@/api/types";

export function latestWorkflowStepAgent(
  data: HerdrSessions | undefined,
  repo: string | undefined,
  runId: number,
  step: "execute" | "verify",
): HerdrAgent | undefined {
  if (!repo) return undefined;
  const agents =
    data?.repos?.find((candidate) => candidate.repo === repo)?.agents ?? [];
  let latest: HerdrAgent | undefined;
  let latestSequence = -1;
  for (const agent of agents) {
    if (
      agent.workflow?.kind !== "step" ||
      agent.workflow.runId !== runId ||
      agent.workflow.step !== step ||
      agent.workflow.sequence < latestSequence
    ) {
      continue;
    }
    latest = agent;
    latestSequence = agent.workflow.sequence;
  }
  return latest;
}

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
