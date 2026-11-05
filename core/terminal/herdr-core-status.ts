import { db } from "../db.ts";
import {
  followHerdrCoreEvents,
  type HerdrCoreEventFollow,
} from "../herdr-core.ts";
import {
  type HerdrRepoSessionsWire,
  type HerdrSessionsWire,
  herdrPaneSessionJSON,
  type PullTerminalWire,
} from "../serialize.ts";
import * as S from "../store.ts";
import { normalizeTerminalBackend } from "../terminal-backend.ts";
import {
  parseWorkflowHerdrAgentName,
  workflowParentHerdrAgentName,
  workflowReplacedParentHerdrAgentName,
  workflowStepHerdrAgentName,
} from "../workflow/herdr-agents.ts";
import {
  HERDR_CORE_PROVIDER,
  HERDR_CORE_SESSION_NAME,
} from "./herdr-core-terminal.ts";

// #2573: agent state for herdr-core repos. `hc events` is the source: its snapshot and events are
// written to herdr_core_terminals here, each real change announced by one event, and terminal/sessions
// reads those rows back in the shape the herdr snapshot has, so every reader of agent status works
// the same for both backends.

export const TERMINAL_AGENT_STATE_CHANGED_EVENT =
  "terminal.agent_state_changed";

type Repo = Pick<S.Repo, "id" | "full_name">;

// What `hc events` says about a terminal: `terminals[]` of the snapshot and the data of `created`.
interface HcTerminal {
  address: string;
  state: string;
  status?: { state?: string } | null;
  turn?: number;
  exit_code?: number | null;
  reason?: string | null;
  labels?: Record<string, string>;
}

function labelNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) ? parsed : null;
}

function terminalState(
  repo: Repo,
  terminal: HcTerminal,
): S.HerdrCoreTerminalState {
  const labels = terminal.labels ?? {};
  return {
    address: terminal.address,
    repo_id: repo.id,
    role: labels["loophub.role"] ?? null,
    pr_number: labelNumber(labels["loophub.pr"]),
    run_id: labelNumber(labels["loophub.run"]),
    seq: labelNumber(labels["loophub.seq"]),
    state: terminal.state,
    status: terminal.status?.state ?? null,
    turn: terminal.turn ?? 0,
    exit_code: terminal.exit_code ?? null,
    reason: terminal.reason ?? null,
  };
}

function announce(repo: Repo, row: S.HerdrCoreTerminalState): void {
  S.emitEvent(repo.id, TERMINAL_AGENT_STATE_CHANGED_EVENT, "lh-worker", {
    address: row.address,
    role: row.role,
    pr: row.pr_number,
    run: row.run_id,
    seq: row.seq,
    state: row.state,
    status: row.status,
    turn: row.turn,
  });
}

// Writes and announces only a real change: a resubscribe replays every terminal in its snapshot.
function record(repo: Repo, next: S.HerdrCoreTerminalState): void {
  const { updated_at: _updatedAt, ...previous } = S.getHerdrCoreTerminal(
    next.address,
  ) ?? { updated_at: "" };
  if (
    (Object.keys(next) as (keyof S.HerdrCoreTerminalState)[]).every(
      (key) =>
        (previous as Partial<S.HerdrCoreTerminalState>)[key] === next[key],
    )
  )
    return;
  S.upsertHerdrCoreTerminal(next);
  announce(repo, next);
}

function remove(repo: Repo, row: S.HerdrCoreTerminalRow): void {
  S.deleteHerdrCoreTerminal(row.address);
  announce(repo, { ...row, state: "removed", status: null });
}

// A subscription's snapshot is the whole truth for its repo: a terminal it no longer lists is gone.
export function applyHerdrCoreSnapshot(
  repo: Repo,
  terminals: HcTerminal[],
): void {
  db.transaction(() => {
    const listed = new Set(terminals.map((terminal) => terminal.address));
    for (const row of S.listHerdrCoreTerminalRows(repo.id)) {
      if (!listed.has(row.address)) remove(repo, row);
    }
    for (const terminal of terminals)
      record(repo, terminalState(repo, terminal));
  });
}

export function applyHerdrCoreEvent(
  repo: Repo,
  event: { type: string; terminal: string; data: Record<string, unknown> },
): void {
  db.transaction(() => {
    if (event.type === "created") {
      record(repo, terminalState(repo, event.data as unknown as HcTerminal));
      return;
    }
    const row = S.getHerdrCoreTerminal(event.terminal);
    if (row?.repo_id !== repo.id) return;
    const { updated_at: _updatedAt, ...current } = row;
    if (event.type === "status") {
      const status = event.data.status as HcTerminal["status"];
      record(repo, { ...current, status: status?.state ?? null });
    } else if (event.type === "turn") {
      record(repo, { ...current, turn: event.data.turn as number });
    } else if (event.type === "finished") {
      record(repo, {
        ...current,
        state: "finished",
        status: null,
        exit_code: (event.data.exit_code as number | null) ?? null,
        reason: (event.data.reason as string | null) ?? null,
      });
    } else if (event.type === "removed") {
      remove(repo, row);
    }
  });
}

// The subscription for one repo. A `missed` means events were dropped, so it ends itself and the
// worker's next subscribe takes a fresh snapshot.
export function followHerdrCoreRepo(repo: Repo): HerdrCoreEventFollow {
  const follow: HerdrCoreEventFollow = followHerdrCoreEvents(
    { "loophub.repo": repo.full_name },
    (message) => {
      const line = message as {
        terminals?: HcTerminal[];
        method?: string;
        params?: Parameters<typeof applyHerdrCoreEvent>[1];
      };
      if (line.terminals) applyHerdrCoreSnapshot(repo, line.terminals);
      else if (line.method === "event" && line.params)
        applyHerdrCoreEvent(repo, line.params);
      else if (line.method === "missed") follow.stop();
    },
  );
  return follow;
}

// The repos to follow: every repo set to herdr-core, plus any that still has a live terminal, because
// a run keeps its backend to the end even after the repo's setting changes.
export function herdrCoreFollowedRepos(): S.Repo[] {
  return S.listRepos("active").filter(
    (repo) =>
      normalizeTerminalBackend(repo.terminal_backend) === "herdr-core" ||
      S.listHerdrCoreTerminalRows(repo.id).some((row) => row.state === "live"),
  );
}

// The dock's tabs for one PR, in the order the agents ran. Finished rows are read too and only left
// out at the end, so `executor #2` keeps its number after `executor #1` has exited.
export function listPullTerminals(
  repo: Repo,
  pull: number,
): PullTerminalWire[] {
  const rows = S.listHerdrCoreTerminalRows(repo.id)
    .filter(
      (row) =>
        row.pr_number === pull &&
        row.run_id !== null &&
        (row.role === "orchestrator" ||
          row.role === "executor" ||
          row.role === "verifier"),
    )
    .sort(
      (a, b) =>
        (a.run_id as number) - (b.run_id as number) ||
        (a.seq ?? 0) - (b.seq ?? 0),
    );
  const severalRuns = new Set(rows.map((row) => row.run_id)).size > 1;
  const counts = new Map<string, number>();
  return rows.flatMap((row) => {
    let name = row.role as string;
    if (row.role !== "orchestrator") {
      const key = `${row.run_id}:${row.role}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      name = `${row.role} #${count}`;
    }
    if (row.state !== "live") return [];
    return [
      {
        address: row.address,
        label: severalRuns ? `run ${row.run_id} · ${name}` : name,
        status: row.status,
      },
    ];
  });
}

// The dock's tabs for New issue on one repo. As above, finished rows keep the later tabs' numbers.
export function listIssueTerminals(repo: Repo): PullTerminalWire[] {
  return S.listHerdrCoreTerminalRows(repo.id)
    .filter((row) => row.role === "issue-create")
    .sort((a, b) => a.address.localeCompare(b.address, "en", { numeric: true }))
    .flatMap((row, index) =>
      row.state === "live"
        ? [
            {
              address: row.address,
              label: `New issue ${index + 1}`,
              status: row.status,
            },
          ]
        : [],
    );
}

// The launcher's own record of a New issue terminal, so the dock can attach to it at once rather than
// after the worker's next look at `hc events`. Whatever the worker already recorded is newer.
export function recordIssueTerminalStarted(repo: Repo, address: string): void {
  db.transaction(() => {
    if (S.getHerdrCoreTerminal(address)) return;
    record(repo, {
      address,
      repo_id: repo.id,
      role: "issue-create",
      pr_number: null,
      run_id: null,
      seq: null,
      state: "live",
      status: null,
      turn: 0,
      exit_code: null,
      reason: null,
    });
  });
}

function sessionIdFor(repo: Repo, address: string): string | null {
  return (
    S.agentSessionForExecutionTarget(HERDR_CORE_PROVIDER, address) ??
    S.getHerdrPaneByCoordinates(repo.id, HERDR_CORE_SESSION_NAME, address)
      ?.launch_id ??
    null
  );
}

function agentName(
  row: S.HerdrCoreTerminalRow,
  sessionId: string | null,
): string {
  if (row.run_id !== null) {
    if (row.role === "orchestrator") {
      const parentSession = S.getWorkflowRun(row.run_id)?.parent_session_id;
      return sessionId && parentSession && sessionId !== parentSession
        ? workflowReplacedParentHerdrAgentName(row.run_id)
        : workflowParentHerdrAgentName(row.run_id);
    }
    if (
      row.seq !== null &&
      (row.role === "executor" || row.role === "verifier")
    )
      return workflowStepHerdrAgentName(
        row.run_id,
        row.role === "executor" ? "execute" : "verify",
        row.seq,
      );
  }
  return row.role ?? row.address;
}

// Null when the repo has nothing to show. Live terminals only, and no New Issue terminals, as in the
// herdr projection.
function projectHerdrCoreRepoSessions(
  repo: S.Repo,
): HerdrRepoSessionsWire | null {
  const rows = S.listHerdrCoreTerminalRows(repo.id)
    .filter((row) => row.state === "live" && row.role !== "issue-create")
    .sort((a, b) =>
      a.address.localeCompare(b.address, "en", { numeric: true }),
    );
  if (rows.length === 0) return null;
  const pullWorkspaces = new Map<
    number,
    { pull: number; pane_id: string; status: string }
  >();
  const issueWorkspaces = new Map<
    number,
    { issue: number; pane_id: string; status: string }
  >();
  const agents = rows.map((row) => {
    const status = row.status ?? "";
    const sessionId = sessionIdFor(repo, row.address);
    const name = agentName(row, sessionId);
    const prRow =
      row.pr_number === null ? null : S.getIssue(repo.id, row.pr_number);
    const pull = prRow?.kind === "pull" ? S.getPull(prRow.id) : null;
    if (row.pr_number !== null && !pullWorkspaces.has(row.pr_number))
      pullWorkspaces.set(row.pr_number, {
        pull: row.pr_number,
        pane_id: row.address,
        status,
      });
    const issue =
      pull?.linked_issue_id != null
        ? S.getIssueById(pull.linked_issue_id)
        : null;
    if (issue && !issueWorkspaces.has(issue.number))
      issueWorkspaces.set(issue.number, {
        issue: issue.number,
        pane_id: row.address,
        status,
      });
    const workflow =
      row.run_id !== null && S.getWorkflowRun(row.run_id)?.repo_id === repo.id
        ? parseWorkflowHerdrAgentName(name)
        : null;
    const session = herdrPaneSessionJSON(sessionId);
    return {
      id: row.address,
      name,
      status,
      pull: row.pr_number,
      pull_closed: prRow?.kind === "pull" && prRow.state !== "open",
      focusable: false,
      ...(workflow ? { workflow } : {}),
      ...(session ? { session } : {}),
    };
  });
  return {
    repo: repo.full_name,
    session_name: HERDR_CORE_SESSION_NAME,
    agents,
    pull_workspaces: [...pullWorkspaces.values()],
    issue_workspaces: [...issueWorkspaces.values()],
  };
}

// Adds the herdr-core agents to what the herdr snapshot holds. A repo can have both while a run
// started before its backend changed is still going.
export function withHerdrCoreSessions(
  sessions: HerdrSessionsWire,
): HerdrSessionsWire {
  const groups = S.listRepos("active").flatMap((repo) => {
    const group = projectHerdrCoreRepoSessions(repo);
    return group ? [group] : [];
  });
  if (groups.length === 0) return sessions;
  const repos = [...sessions.repos];
  for (const group of groups) {
    const index = repos.findIndex((other) => other.repo === group.repo);
    if (index < 0) {
      repos.push(group);
      continue;
    }
    repos[index] = {
      ...repos[index],
      agents: [...repos[index].agents, ...group.agents],
      pull_workspaces: [
        ...repos[index].pull_workspaces,
        ...group.pull_workspaces,
      ],
      issue_workspaces: [
        ...repos[index].issue_workspaces,
        ...group.issue_workspaces,
      ],
    };
  }
  return {
    ...sessions,
    repos,
    // Absent means herdr's sessions could not be read. A herdr-core agent says nothing about those,
    // so it stays absent rather than reading as "every other repo's session is not running".
    ...(sessions.running_repos
      ? {
          running_repos: [
            ...new Set([
              ...sessions.running_repos,
              ...groups.map((group) => group.repo),
            ]),
          ],
        }
      : {}),
  };
}
