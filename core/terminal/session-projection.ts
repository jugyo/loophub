// Projects one repo's live Herdr agents onto the terminal.sessions wire shape (#495/#611/#821).
// Everything here is a pure read: the raw `herdr agent list` output plus what the DB knows about
// the panes' worktrees. Running herdr — the session sweep, the per-repo `agent list` capture, and
// the failure tolerance around them — stays in core/service/terminal.ts, so this module can be
// exercised with a JSON string and a few DB rows instead of a fake herdr on PATH.
import {
  type HerdrRepoSessionsWire,
  herdrPaneSessionJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import {
  parseLegacyWorkflowParentHerdrAgentName,
  parseLegacyWorkflowStepHerdrAgentName,
  parseWorkflowHerdrAgentName,
  type WorkflowHerdrAgent,
  workflowStepSessionIds,
} from "../workflow/herdr-agents.ts";
import {
  herdrIssueWorkspacesFromAgentList,
  herdrPullWorkspacesFromAgentList,
  parseHerdrAgentPlacements,
} from "./herdr-status.ts";
import { HERDR_ID } from "./terminal-launch.ts";

export interface SessionProjectionRepo {
  id: number;
  full_name: string;
}

type HerdrPlacement = ReturnType<typeof parseHerdrAgentPlacements>[number];

function paneWorkflowAgents(
  repoId: number,
  placements: HerdrPlacement[],
): Map<string, WorkflowHerdrAgent> {
  const out = new Map<string, WorkflowHerdrAgent>();
  for (const placement of placements) {
    const workflow = parseWorkflowHerdrAgentName(placement.name);
    if (workflow) {
      out.set(placement.id, workflow);
      continue;
    }
    const legacyStep = parseLegacyWorkflowStepHerdrAgentName(placement.name);
    if (legacyStep) {
      out.set(placement.id, { ...legacyStep, sequence: 0 });
      continue;
    }
    if (placement.pull === null) continue;
    const parentSessionPrefix = parseLegacyWorkflowParentHerdrAgentName(
      placement.name,
    );
    if (!parentSessionPrefix) continue;
    const run = S.workflowRunForLegacyParent(
      repoId,
      placement.pull,
      parentSessionPrefix,
    );
    if (run) out.set(placement.id, { kind: "parent", runId: run.id });
  }
  return out;
}

// Resolve the LoopHub session behind each live pane. Workflow parents store their id directly;
// Workflow children persist the exact Herdr pane title on their session row. A pre-upgrade run is
// still safe to resolve when a step has only one session; multiple legacy sessions stay unresolved
// rather than guessing by position. Ordinary PR panes resolve only through the exact durable pane
// id recorded at launch; pre-registry panes stay unresolved rather than borrowing the PR's primary
// dev-session anchor.
function paneSessionIds(
  repoId: number,
  sessionName: string,
  placements: HerdrPlacement[],
  workflowAgents: Map<string, WorkflowHerdrAgent>,
): Map<string, string> {
  const out = new Map<string, string>();
  const ordinaryPanesByPull = new Map<number, S.HerdrPaneRow[]>();
  const placementNameCounts = new Map<string, number>();
  for (const placement of placements) {
    placementNameCounts.set(
      placement.name,
      (placementNameCounts.get(placement.name) ?? 0) + 1,
    );
  }
  for (const placement of placements) {
    const workflow = workflowAgents.get(placement.id);
    if (!workflow) {
      if (placement.pull === null) continue;
      let registered = ordinaryPanesByPull.get(placement.pull);
      if (!registered) {
        registered = S.listHerdrPanesForResource({
          repoId,
          resourceKind: "pull",
          resourceKey: String(placement.pull),
        });
        ordinaryPanesByPull.set(placement.pull, registered);
      }
      const matches = registered.filter(
        (pane) =>
          pane.pane_id === placement.id &&
          pane.session_name === sessionName &&
          pane.closed_at === null &&
          S.getAgentSession(pane.launch_id),
      );
      const match = matches.sort(
        (a, b) =>
          b.updated_at.localeCompare(a.updated_at) ||
          b.created_at.localeCompare(a.created_at) ||
          b.id - a.id,
      )[0];
      if (match) out.set(placement.id, match.launch_id);
      continue;
    }
    const run = S.getWorkflowRun(workflow.runId);
    if (!run || run.repo_id !== repoId || run.pr_number !== placement.pull) {
      continue;
    }
    if (workflow.kind === "parent") {
      if (run.parent_session_id) out.set(placement.id, run.parent_session_id);
      continue;
    }
    const step = workflow.step;
    const candidates = workflowStepSessionIds(run.step_sessions_json, step);
    const namedCandidates = candidates.filter(
      (candidate) => S.getAgentSession(candidate)?.name === placement.name,
    );
    const placementNameIsUnique = placementNameCounts.get(placement.name) === 1;
    const sessionId =
      (placementNameIsUnique && namedCandidates.length === 1
        ? namedCandidates[0]
        : undefined) ??
      (placementNameIsUnique &&
      candidates.length === 1 &&
      S.getAgentSession(candidates[0])?.name ===
        `Workflow ${step} run #${run.id}`
        ? candidates[0]
        : undefined);
    if (sessionId) out.set(placement.id, sessionId);
  }
  return out;
}

function isIssueCreateAgentName(name: string): boolean {
  return (
    name === "New issue" ||
    name.startsWith("New issue - ") ||
    name.startsWith("New issue (")
  );
}

function isIssueCreateAgent(
  agent: { id: string; name: string; pull: number | null },
  issueCreatePaneIds: Set<string>,
): boolean {
  return (
    issueCreatePaneIds.has(agent.id) ||
    (agent.pull === null && isIssueCreateAgentName(agent.name))
  );
}

// Builds the repo group terminal.sessions reports for one running herdr session, from that
// session's raw `agent list` output. Returns null when the group has nothing to show — no agents
// at all, or only New Issue panes — so terminal-aware sections only appear when there is actual
// agent activity.
export function projectHerdrRepoSessions(
  repo: SessionProjectionRepo,
  sessionName: string,
  agentsOut: string,
  worktreeRootPath: string,
): HerdrRepoSessionsWire | null {
  // Placements (not parseHerdrAgentList) so each agent carries the PR its cwd
  // resolves to — same id/name/status semantics, same `agent list` output (#611).
  const placements = parseHerdrAgentPlacements(
    agentsOut,
    worktreeRootPath,
    repo.full_name,
  );
  if (placements.length === 0) return null;
  const issueCreatePaneIds = new Set(
    S.listIssueHerdrPanes(repo.id)
      .map((p) => p.pane_id)
      .filter((paneId): paneId is string => !!paneId),
  );
  const visiblePlacements = placements.filter(
    (agent) => !isIssueCreateAgent(agent, issueCreatePaneIds),
  );
  if (visiblePlacements.length === 0) return null;
  const workflowAgents = paneWorkflowAgents(repo.id, visiblePlacements);
  const sessionIds = paneSessionIds(
    repo.id,
    sessionName,
    visiblePlacements,
    workflowAgents,
  );
  // One DB lookup per distinct PR number — several agents often share a worktree.
  const closedByPull = new Map<number, boolean>();
  const agents = visiblePlacements.map(({ id, name, status, pull }) => {
    let closed = false;
    if (pull !== null) {
      let known = closedByPull.get(pull);
      if (known === undefined) {
        const row = S.getIssue(repo.id, pull);
        // A pr-<n> dir with no matching PR row (or a same-numbered issue) resolves
        // to nothing — render normally rather than guessing staleness.
        known = !!row && row.kind === "pull" && row.state !== "open";
        closedByPull.set(pull, known);
      }
      closed = known;
    }
    const workflow = workflowAgents.get(id);
    const session = herdrPaneSessionJSON(sessionIds.get(id) ?? null);
    return {
      id,
      name,
      status,
      pull,
      pull_closed: closed,
      focusable: HERDR_ID.test(id),
      ...(workflow ? { workflow } : {}),
      ...(session ? { session } : {}),
    };
  });
  const pullWorkspaces = herdrPullWorkspacesFromAgentList(
    agentsOut,
    worktreeRootPath,
    repo.full_name,
  );
  // PR→issue for the pulls a workspace resolves to, so herdrIssueWorkspacesFromAgentList can
  // key the same panes by issue number (#821). The link is the PR's linked_issue_id, recorded
  // when the run opened the PR (`Closes #<n>`); a PR with no linked issue is simply absent
  // from the map and skipped there, matching the parser's degrade-to-empty tolerance.
  const pullToIssue = new Map<number, number>();
  for (const w of pullWorkspaces) {
    const prRow = S.getIssue(repo.id, w.pull);
    if (prRow?.kind !== "pull") continue;
    const pull = S.getPull(prRow.id);
    if (pull?.linked_issue_id == null) continue;
    const linkedIssue = S.getIssueById(pull.linked_issue_id);
    if (linkedIssue) pullToIssue.set(w.pull, linkedIssue.number);
  }
  const issueWorkspaces = herdrIssueWorkspacesFromAgentList(
    agentsOut,
    worktreeRootPath,
    repo.full_name,
    pullToIssue,
  );
  return {
    repo: repo.full_name,
    session_name: sessionName,
    agents,
    pull_workspaces: pullWorkspaces,
    issue_workspaces: issueWorkspaces,
  };
}
