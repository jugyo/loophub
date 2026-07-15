import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-herdr-sessions-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let db: typeof import("./db.ts").db;
let herdrSessionName: (repo: {
  full_name: string;
  local_path: string;
}) => string;
let worktreeRoot: () => string;
let worktreePath: (root: string, fullName: string, pr: number) => string;

const ORIGINAL_PATH = process.env.PATH;
// Two PATH prefixes the tests switch between: one with a fake `herdr` on it, one empty
// (so spawning `herdr` fails with ENOENT — the "herdr not installed" path).
const FAKE_BIN = join(HOME, "fake-bin");
const EMPTY_BIN = join(HOME, "empty-bin");

function initGitRepo(): string {
  const path = mkdtempSync(join(HOME, "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  return path;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  ({ db } = await import("./db.ts"));
  ({ herdrSessionName } = await import("./terminal/terminal-launch.ts"));
  ({ worktreeRoot } = await import("./config.ts"));
  ({ worktreePath } = await import("./worktree-path.ts"));
  mkdirSync(FAKE_BIN);
  mkdirSync(EMPTY_BIN);
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(HOME, { recursive: true, force: true });
});

test("terminal.sessions reports running repos independently from visible agent groups", async () => {
  const withAgents = await svc.repos.create({
    path: initGitRepo(),
    name: "me/with-agents",
  });
  const agentless = await svc.repos.create({
    path: initGitRepo(),
    name: "me/agentless",
  });
  const agentListFailure = await svc.repos.create({
    path: initGitRepo(),
    name: "me/agent-list-failure",
  });
  await svc.repos.create({ path: initGitRepo(), name: "me/not-running" });

  const sessionA = herdrSessionName(withAgents);
  const sessionB = herdrSessionName(agentless);
  const sessionC = herdrSessionName(agentListFailure);

  // Fake herdr replaying real CLI shapes: `herdr session list --json` prints the session
  // list; `herdr --session <name> agent list` ($2 = name) prints that session's agents.
  const sessionList = JSON.stringify({
    sessions: [
      { default: true, name: "default", running: true },
      { default: false, name: sessionA, running: true },
      { default: false, name: sessionB, running: true },
      { default: false, name: sessionC, running: true },
    ],
  });
  const agents = JSON.stringify({
    id: "cli:agent:list",
    result: {
      agents: [
        {
          agent: "claude",
          agent_status: "working",
          name: "dev #11",
          pane_id: "w1:p2",
        },
        {
          agent: "claude",
          agent_status: "blocked",
          name: "dev #13",
          pane_id: "w1:pC",
        },
        {
          agent: "claude",
          agent_status: "idle",
          name: "legacy without pane id",
        },
      ],
      type: "agent_list",
    },
  });
  const empty = JSON.stringify({
    id: "cli:agent:list",
    result: { agents: [], type: "agent_list" },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `if [ "$2" = "${sessionA}" ]; then printf '%s' '${agents}'; exit 0; fi`,
      `if [ "$2" = "${sessionC}" ]; then exit 1; fi`,
      `printf '%s' '${empty}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.sessions();
    expect(result.running_repos).toEqual([
      "me/with-agents",
      "me/agentless",
      "me/agent-list-failure",
    ]);
    // me/agentless runs a session with zero agents and me/not-running has no session —
    // neither produces a group. A failed agent list is likewise absent from repos without
    // hiding the independently confirmed running session.
    expect(result.repos).toEqual([
      {
        repo: "me/with-agents",
        session_name: sessionA,
        agents: [
          {
            id: "w1:p2",
            name: "dev #11",
            status: "working",
            pull: null,
            pull_closed: false,
            focusable: true,
          },
          {
            id: "w1:pC",
            name: "dev #13",
            status: "blocked",
            pull: null,
            pull_closed: false,
            focusable: true,
          },
          {
            id: `${String.fromCharCode(0)}idx:2`,
            name: "legacy without pane id",
            status: "idle",
            pull: null,
            pull_closed: false,
            focusable: false,
          },
        ],
        pull_workspaces: [],
        issue_workspaces: [],
      },
    ]);
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sessions hides New Issue agents but keeps normal repo-root agents", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/new-issue-hidden",
  });
  const sessionName = herdrSessionName(repo);
  const openPr = S.createIssue(repo.id, "pull", "open", "", "me");
  S.createPull(openPr.id, "loophub/pr-1", "main", null);

  S.upsertIssueHerdrPane({
    launchId: "launch-new-issue",
    repoId: repo.id,
    paneId: "wN:p1",
    sessionName,
  });

  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          agent: "claude",
          agent_status: "working",
          name: "New issue - abcdef12",
          pane_id: "wN:p1",
          foreground_cwd: repo.local_path,
        },
        {
          agent: "claude",
          agent_status: "working",
          name: "New issue",
          pane_id: "wN:p2",
          foreground_cwd: repo.local_path,
        },
        {
          agent: "claude",
          agent_status: "working",
          name: "dev #1",
          pane_id: "wN:p3",
          foreground_cwd: worktreePath(worktreeRoot(), repo.full_name, 1),
        },
        {
          agent: "claude",
          agent_status: "idle",
          name: "repo shell",
          pane_id: "wN:p4",
          foreground_cwd: repo.local_path,
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `printf '%s' '${agents}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.sessions();
    expect(result.repos).toEqual([
      {
        repo: "me/new-issue-hidden",
        session_name: sessionName,
        agents: [
          {
            id: "wN:p3",
            name: "dev #1",
            status: "working",
            pull: 1,
            pull_closed: false,
            focusable: true,
          },
          {
            id: "wN:p4",
            name: "repo shell",
            status: "idle",
            pull: null,
            pull_closed: false,
            focusable: true,
          },
        ],
        pull_workspaces: [{ pull: 1, pane_id: "wN:p3", status: "working" }],
        issue_workspaces: [],
      },
    ]);
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// #579: the issue-list Herdr badge needs to know which PR a running agent's terminal belongs
// to. terminal.sessions resolves that from the same `agent list` output, without an extra
// herdr shellout, by matching an agent's foreground_cwd against the PR's deterministic
// worktree path.
test("terminal.sessions maps a running agent's cwd back to its PR (#579)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/pull-workspace",
  });
  const sessionName = herdrSessionName(repo);
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, 12);

  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          agent: "claude",
          agent_status: "working",
          name: "Issue #9 - PR 12",
          pane_id: "wP:p2",
          cwd: "/some/repo/root",
          foreground_cwd: prWorktree,
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `printf '%s' '${agents}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.sessions();
    expect(result.repos).toEqual([
      {
        repo: "me/pull-workspace",
        session_name: sessionName,
        agents: [
          {
            id: "wP:p2",
            name: "Issue #9 - PR 12",
            status: "working",
            pull: 12,
            pull_closed: false,
            focusable: true,
          },
        ],
        pull_workspaces: [{ pull: 12, pane_id: "wP:p2", status: "working" }],
        // PR 12 has no linked issue here, so nothing resolves to an issue.
        issue_workspaces: [],
      },
    ]);
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sessions maps ordinary panes to their exact persisted sessions", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/ordinary-pane-sessions",
  });
  const sessionName = herdrSessionName(repo);
  const pr = S.createIssue(repo.id, "pull", "the PR", "", "me");
  S.createPull(pr.id, `loophub/pr-${pr.number}`, "main", null);
  const oldSession = "ordinary-old-session";
  const newSession = "ordinary-new-session";
  for (const sessionId of [oldSession, newSession]) {
    S.registerAgentSession(
      sessionId,
      "lh-build",
      sessionId,
      null,
      "codex",
      "dev",
    );
    S.setPullSession(pr.id, sessionId);
  }
  S.upsertSessionUsage(oldSession, {
    model: "gpt-5-codex",
    input_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 20,
    output_tokens: 30,
    cost_usd: 1.25,
  });
  S.upsertSessionUsage(newSession, {
    model: "gpt-5-codex",
    input_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 40,
    output_tokens: 60,
    cost_usd: 2.5,
  });
  for (const [sessionId, paneId] of [
    [oldSession, "wO:p1"],
    [newSession, "wO:p2"],
  ] as const) {
    S.registerHerdrPane({
      repoId: repo.id,
      launchId: sessionId,
      paneId,
      sessionName,
      displayName: `dev ${sessionId}`,
      origin: "build",
    });
    S.linkHerdrPaneResource({
      repoId: repo.id,
      launchId: sessionId,
      resourceKind: "pull",
      resourceKey: String(pr.number),
    });
  }
  const staleSession = "stale-pane-registration";
  S.registerAgentSession(staleSession, "dev", staleSession, "stale dev pane");
  const stalePane = S.registerHerdrPane({
    repoId: repo.id,
    launchId: staleSession,
    paneId: "wO:p2",
    sessionName,
    displayName: "stale dev pane",
    origin: "build",
  });
  S.linkHerdrPaneResource({
    repoId: repo.id,
    launchId: staleSession,
    resourceKind: "pull",
    resourceKey: String(pr.number),
  });
  S.markHerdrPaneClosed(stalePane.id);

  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          name: "old dev pane",
          agent_status: "idle",
          pane_id: "wO:p1",
          foreground_cwd: prWorktree,
        },
        {
          name: "new dev pane",
          agent_status: "working",
          pane_id: "wO:p2",
          foreground_cwd: prWorktree,
        },
        {
          name: "unmapped legacy pane",
          agent_status: "idle",
          pane_id: "wO:p3",
          foreground_cwd: prWorktree,
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `printf '%s' '${agents}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.sessions();
    expect(result.repos[0]?.agents).toMatchObject([
      {
        id: "wO:p1",
        session: {
          id: oldSession,
          usage: { total_tokens: 150, cost_usd: 1.25 },
        },
      },
      {
        id: "wO:p2",
        session: {
          id: newSession,
          usage: { total_tokens: 300, cost_usd: 2.5 },
        },
      },
      { id: "wO:p3" },
    ]);
    expect(result.repos[0]?.agents[2]).not.toHaveProperty("session");
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sessions enriches Workflow panes with hierarchy and session usage", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/workflow-pane-details",
  });
  const sessionName = herdrSessionName(repo);
  const issue = S.createIssue(repo.id, "issue", "issue", "", "me");
  const pr = S.createIssue(repo.id, "pull", "pull", "", "me");
  S.createPull(pr.id, `loophub/pr-${pr.number}`, "main", null, issue.id);
  const workflow = S.createWorkflow({
    name: "Pane details workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parentSession = "a1b2c3d4-parent-pane-session";
  const executeSession = "execute-pane-session";
  const closedExecuteSession = "closed-execute-pane-session";
  const latestExecuteSession = "latest-execute-pane-session";
  const legacyExecuteSession = "legacy-execute-pane-session";
  const fallbackExecuteSession = "fallback-execute-pane-session";
  const verifySession = "verify-pane-session";
  S.registerAgentSession(
    parentSession,
    "workflow-parent",
    parentSession,
    "Workflow parent",
    "codex",
    "workflow-parent",
  );
  for (const [sessionId, step] of [
    [executeSession, "execute"],
    [verifySession, "verify"],
  ] as const) {
    S.registerAgentSession(
      sessionId,
      "workflow-step",
      sessionId,
      `Workflow ${step}`,
      "codex",
      "workflow-step",
    );
  }
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: pr.number,
    status: "running",
    currentStep: "verify",
    parentSessionId: parentSession,
  });
  S.registerAgentSession(
    executeSession,
    "workflow-step",
    executeSession,
    `executor #${run.id}-1`,
  );
  S.registerAgentSession(
    verifySession,
    "workflow-step",
    verifySession,
    `Workflow verify run #${run.id}`,
  );
  S.registerAgentSession(
    closedExecuteSession,
    "workflow-step",
    closedExecuteSession,
    `executor #${run.id}-3`,
  );
  S.registerAgentSession(
    latestExecuteSession,
    "workflow-step",
    latestExecuteSession,
    `executor #${run.id}-4`,
  );
  S.registerAgentSession(
    legacyExecuteSession,
    "workflow-step",
    legacyExecuteSession,
    `workflow execute #${run.id}`,
  );
  S.registerAgentSession(
    fallbackExecuteSession,
    "workflow-step",
    fallbackExecuteSession,
    `Workflow execute run #${run.id}`,
  );
  S.appendWorkflowRunStepSession(run.id, "execute", executeSession);
  S.appendWorkflowRunStepSession(run.id, "verify", verifySession);
  S.appendWorkflowRunStepSession(run.id, "execute", closedExecuteSession);
  S.appendWorkflowRunStepSession(run.id, "execute", latestExecuteSession);
  S.appendWorkflowRunStepSession(run.id, "execute", legacyExecuteSession);
  S.appendWorkflowRunStepSession(run.id, "execute", fallbackExecuteSession);
  S.upsertSessionUsage(executeSession, {
    model: "gpt-5-codex",
    input_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 20,
    output_tokens: 30,
    cost_usd: 1.25,
  });

  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          name: `orchestrator #${run.id}`,
          agent_status: "working",
          pane_id: "wW:p1",
          foreground_cwd: prWorktree,
        },
        {
          name: `executor #${run.id}-1`,
          agent_status: "done",
          pane_id: "wW:p2",
          foreground_cwd: prWorktree,
        },
        {
          name: `verifier #${run.id}-2`,
          agent_status: "working",
          pane_id: "wW:p3",
          foreground_cwd: prWorktree,
        },
        {
          name: `executor #${run.id}-4`,
          agent_status: "working",
          pane_id: "wW:p4",
          foreground_cwd: prWorktree,
        },
        {
          name: `workflow verify #${run.id}`,
          agent_status: "working",
          pane_id: "wW:p5",
          foreground_cwd: prWorktree,
        },
        {
          name: `Workflow execute run #${run.id}`,
          agent_status: "working",
          pane_id: "wW:p9",
          foreground_cwd: prWorktree,
        },
        {
          name: "workflow-a1b2c3d4",
          agent_status: "working",
          pane_id: "wW:p6",
          foreground_cwd: prWorktree,
        },
        {
          name: `workflow execute #${run.id}`,
          agent_status: "working",
          pane_id: "wW:p7",
          foreground_cwd: prWorktree,
        },
        {
          name: `workflow verify #${run.id}`,
          agent_status: "working",
          pane_id: "wW:p8",
          foreground_cwd: prWorktree,
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `printf '%s' '${agents}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.sessions();
    expect(result.repos[0]?.agents).toMatchObject([
      {
        id: "wW:p1",
        workflow: { kind: "parent", runId: run.id },
        session: { id: parentSession, runtime: "codex" },
      },
      {
        id: "wW:p2",
        workflow: {
          kind: "step",
          runId: run.id,
          step: "execute",
          sequence: 1,
        },
        session: {
          id: executeSession,
          usage: { total_tokens: 150, cost_usd: 1.25 },
        },
      },
      {
        id: "wW:p3",
        workflow: {
          kind: "step",
          runId: run.id,
          step: "verify",
          sequence: 2,
        },
        session: { id: verifySession },
      },
      {
        id: "wW:p4",
        workflow: {
          kind: "step",
          runId: run.id,
          step: "execute",
          sequence: 4,
        },
        session: { id: latestExecuteSession },
      },
      {
        id: "wW:p5",
        workflow: {
          kind: "step",
          runId: run.id,
          step: "verify",
          sequence: 0,
        },
      },
      {
        id: "wW:p9",
        workflow: {
          kind: "step",
          runId: run.id,
          step: "execute",
          sequence: 0,
        },
        session: { id: fallbackExecuteSession },
      },
      {
        id: "wW:p6",
        workflow: { kind: "parent", runId: run.id },
        session: { id: parentSession, runtime: "codex" },
      },
      {
        id: "wW:p7",
        workflow: {
          kind: "step",
          runId: run.id,
          step: "execute",
          sequence: 0,
        },
        session: { id: legacyExecuteSession },
      },
      {
        id: "wW:p8",
        workflow: {
          kind: "step",
          runId: run.id,
          step: "verify",
          sequence: 0,
        },
      },
    ]);
    const collidingRun = S.createWorkflowRun({
      workflowId: workflow.id,
      repoId: repo.id,
      issueNumber: issue.number,
      prNumber: pr.number,
      status: "running",
      currentStep: "execute",
      parentSessionId: "a1b2c3d4-colliding-parent",
    });
    expect(collidingRun.id).not.toBe(run.id);
    expect(
      S.workflowRunForLegacyParent(repo.id, pr.number, "a1b2c3d4"),
    ).toBeNull();
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// #821: the issue-detail Agents section needs each running agent keyed back to the *issue* its PR
// closes, not just the PR. terminal.sessions composes cwd→PR (as in #579 above) with the PR's
// linked_issue_id (recorded when `lh build` opened the PR) to fill issue_workspaces.
test("terminal.sessions maps a running agent's PR back to its linked issue (#821)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/issue-workspace",
  });
  const sessionName = herdrSessionName(repo);
  // Sequential numbers per repo: #1 = the issue, #2 = the PR that closes it. The PR is created
  // directly in the store (a bare temp repo has no head branch for pulls.create) and linked to the
  // issue via linked_issue_id, mirroring what `lh build` records when it opens the PR.
  const issue = S.createIssue(repo.id, "issue", "the issue", "", "me");
  const pr = S.createIssue(repo.id, "pull", "the PR", "", "me");
  // createPull(issueId, head, base, headSha, linkedIssueId): the issue link is the 5th arg.
  S.createPull(pr.id, "loophub/pr-2", "main", null, issue.id);
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);

  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          agent: "claude",
          agent_status: "working",
          name: `dev #${pr.number}`,
          pane_id: "wI:p2",
          foreground_cwd: prWorktree,
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `printf '%s' '${agents}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.sessions();
    expect(result.repos).toEqual([
      {
        repo: "me/issue-workspace",
        session_name: sessionName,
        agents: [
          {
            id: "wI:p2",
            name: `dev #${pr.number}`,
            status: "working",
            pull: pr.number,
            pull_closed: false,
            focusable: true,
          },
        ],
        pull_workspaces: [
          { pull: pr.number, pane_id: "wI:p2", status: "working" },
        ],
        issue_workspaces: [
          { issue: issue.number, pane_id: "wI:p2", status: "working" },
        ],
      },
    ]);
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// #611: the sidebar grays out agents whose worktree PR is finished. terminal.sessions
// resolves each agent's cwd to a PR (same placement parse as #602) and flags the ones
// whose PR is merged or closed; an open PR, an unknown pr-<n> dir, and a repo-root cwd
// all stay unflagged.
test("terminal.sessions flags agents whose worktree PR is merged or closed (#611)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/stale-agents",
  });
  const sessionName = herdrSessionName(repo);
  // PR rows created directly in the store: pulls.create at the service level needs a real
  // head branch, which these bare temp repos don't have. Numbers are sequential per repo,
  // so #1 = merged, #2 = closed unmerged, #3 = open.
  const mergedPr = S.createIssue(repo.id, "pull", "merged", "", "me");
  S.createPull(mergedPr.id, "loophub/pr-1", "main", null);
  S.setMerged(mergedPr.id, "0000000000000000000000000000000000000000", "merge");
  const closedPr = S.createIssue(repo.id, "pull", "closed", "", "me");
  S.createPull(closedPr.id, "loophub/pr-2", "main", null);
  S.updateIssue(closedPr.id, { state: "closed" });
  const openPr = S.createIssue(repo.id, "pull", "open", "", "me");
  S.createPull(openPr.id, "loophub/pr-3", "main", null);

  const root = worktreeRoot();
  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          agent: "claude",
          agent_status: "done",
          name: "dev #1",
          pane_id: "wS:p1",
          foreground_cwd: worktreePath(root, repo.full_name, 1),
        },
        {
          agent: "claude",
          agent_status: "idle",
          name: "dev #2",
          pane_id: "wS:p2",
          foreground_cwd: worktreePath(root, repo.full_name, 2),
        },
        {
          agent: "claude",
          agent_status: "working",
          name: "dev #3",
          pane_id: "wS:p3",
          foreground_cwd: worktreePath(root, repo.full_name, 3),
        },
        {
          // pr-99 exists as a dir name but no such PR row — must not be guessed stale.
          agent: "claude",
          agent_status: "working",
          name: "dev #99",
          pane_id: "wS:p4",
          foreground_cwd: worktreePath(root, repo.full_name, 99),
        },
        {
          agent: "claude",
          agent_status: "idle",
          name: "shell",
          pane_id: "wS:p5",
          foreground_cwd: repo.local_path,
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `printf '%s' '${agents}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.sessions();
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].agents).toEqual([
      {
        id: "wS:p1",
        name: "dev #1",
        status: "done",
        pull: 1,
        pull_closed: true,
        focusable: true,
      },
      {
        id: "wS:p2",
        name: "dev #2",
        status: "idle",
        pull: 2,
        pull_closed: true,
        focusable: true,
      },
      {
        id: "wS:p3",
        name: "dev #3",
        status: "working",
        pull: 3,
        pull_closed: false,
        focusable: true,
      },
      {
        id: "wS:p4",
        name: "dev #99",
        status: "working",
        pull: 99,
        pull_closed: false,
        focusable: true,
      },
      // Repo-root cwd resolves to no PR (pull null) — a "New issue" agent shape (#633).
      {
        id: "wS:p5",
        name: "shell",
        status: "idle",
        pull: null,
        pull_closed: false,
        focusable: true,
      },
    ]);
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sessions is empty when herdr is not on PATH", async () => {
  process.env.PATH = EMPTY_BIN;
  try {
    expect(await svc.terminal.sessions()).toEqual({ repos: [] });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sessions is empty when herdr exits non-zero", async () => {
  writeFileSync(join(FAKE_BIN, "herdr"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    expect(await svc.terminal.sessions()).toEqual({ repos: [] });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sessions distinguishes a confirmed empty list from malformed output", async () => {
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    "#!/bin/sh\nprintf '%s' '{\"sessions\":[]}'\n",
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    expect(await svc.terminal.sessions()).toEqual({
      repos: [],
      running_repos: [],
    });

    writeFileSync(
      join(FAKE_BIN, "herdr"),
      "#!/bin/sh\nprintf '%s' 'not-json'\n",
    );
    expect(await svc.terminal.sessions()).toEqual({ repos: [] });

    writeFileSync(
      join(FAKE_BIN, "herdr"),
      `#!/bin/sh\nprintf '%s' '${JSON.stringify({ sessions: [{ running: true }, 42] })}'\n`,
    );
    expect(await svc.terminal.sessions()).toEqual({ repos: [] });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.agentRead returns the preview text on success (#500)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/agent-read",
  });
  const sessionName = herdrSessionName(repo);
  const read = JSON.stringify({
    id: "cli:agent:read",
    result: { read: { text: "$ npm test\n42 passing\n" } },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      // argv: herdr --session <name> agent read <target> --source recent --lines <n>
      `if [ "$2" = "${sessionName}" ] && [ "$4" = "read" ] && [ "$5" = "dev #11" ]; then printf '%s' '${read}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.agentRead({
      repo: repo.full_name,
      target: "dev #11",
    });
    // The fake herdr above only handles `agent read`, so `pane layout` (below) falls
    // through to `exit 1` — cols/rows degrade to null without failing the read.
    expect(result).toEqual({
      output: "$ npm test\n42 passing\n",
      cols: null,
      rows: null,
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.agentRead includes the pane's size when `pane layout` succeeds (#531)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/agent-read-layout",
  });
  const sessionName = herdrSessionName(repo);
  const read = JSON.stringify({
    result: { read: { text: "$ npm test\n42 passing\n" } },
  });
  const layout = JSON.stringify({
    result: { layout: { area: { height: 85, width: 239, x: 36, y: 1 } } },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      // argv: herdr --session <name> agent read <target> --source recent --lines <n>
      `if [ "$2" = "${sessionName}" ] && [ "$4" = "read" ] && [ "$5" = "w1:p2" ]; then printf '%s' '${read}'; exit 0; fi`,
      // argv: herdr --session <name> pane layout --pane <target>
      `if [ "$2" = "${sessionName}" ] && [ "$4" = "layout" ] && [ "$6" = "w1:p2" ]; then printf '%s' '${layout}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.agentRead({
      repo: repo.full_name,
      target: "w1:p2",
    });
    expect(result).toEqual({
      output: "$ npm test\n42 passing\n",
      cols: 239,
      rows: 85,
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.agentRead degrades to a null output when herdr errors (agent gone, herdr missing, etc.)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/agent-read-missing",
  });
  writeFileSync(join(FAKE_BIN, "herdr"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    expect(
      await svc.terminal.agentRead({
        repo: repo.full_name,
        target: "no-such-agent",
      }),
    ).toEqual({ output: null, cols: null, rows: null });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }

  process.env.PATH = EMPTY_BIN;
  try {
    expect(
      await svc.terminal.agentRead({
        repo: repo.full_name,
        target: "dev #11",
      }),
    ).toEqual({ output: null, cols: null, rows: null });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.agentRead degrades to a null output when the repo no longer exists", async () => {
  // Covers the TOCTOU window between the sidebar's last terminal/sessions poll and a
  // hover firing after the repo was archived/removed in between.
  expect(
    await svc.terminal.agentRead({
      repo: "me/never-registered",
      target: "dev #11",
    }),
  ).toEqual({ output: null, cols: null, rows: null });
});

// #521/#805: sidebar kill button. killAgent reads the pane's foreground process (group) id via
// `pane process-info` and signals it directly instead of asking herdr to close the pane — `pane
// close` refuses with `confirmation_required` whenever the pane is the last one in a
// worktree-linked workspace, which every single-tab launch is by default (#805). The kill itself
// must complete regardless; a best-effort `pane close` still fires afterward to tidy up the now-
// empty pane, but its failure (simulated here as a no-op fake) must not affect the result.
test("terminal.killAgent kills the pane's foreground process instead of closing it directly", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/kill-target",
  });
  const sessionName = herdrSessionName(repo);
  const CALLS_FILE = join(HOME, "kill-calls.txt");
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `echo "$@" >> ${CALLS_FILE}`,
      `if [ "$4" = "process-info" ]; then printf '%s' '{"result":{"process_info":{"foreground_process_group_id":999999}}}'; exit 0; fi`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  // Mocked rather than left to hit the real OS: the fake herdr's foreground_process_group_id is
  // an arbitrary placeholder, not a pid this test actually owns, so signaling it for real would
  // either no-op by luck (ESRCH) or, if that pid/pgid ever exists on the runner, SIGKILL an
  // unrelated live process (#805 review).
  const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    await expect(
      svc.terminal.killAgent({ repo: "me/kill-target", paneId: "w1:p2" }),
    ).resolves.toEqual({ ok: true });
    expect(killSpy).toHaveBeenCalledWith(-999999, "SIGKILL");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(CALLS_FILE, "utf8")).toContain(
      `--session ${sessionName} pane process-info --pane w1:p2`,
    );
    // The follow-up `pane close` is fire-and-forget, so it can still be in flight once killAgent
    // itself resolves — poll instead of asserting immediately.
    const deadline = Date.now() + 2000;
    while (!readFileSync(CALLS_FILE, "utf8").includes("pane close w1:p2")) {
      if (Date.now() > deadline)
        throw new Error("timed out waiting for the best-effort pane close");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(readFileSync(CALLS_FILE, "utf8")).toContain(
      `--session ${sessionName} pane close w1:p2`,
    );
  } finally {
    killSpy.mockRestore();
    process.env.PATH = ORIGINAL_PATH;
  }
});

// The primary kill must still succeed even when the best-effort tidy-up close is refused
// (herdr's `confirmation_required` — "closing this pane would close a worktree group", #805) —
// only the pane's foreground process actually has to die.
test("terminal.killAgent succeeds even when the follow-up pane close is refused", async () => {
  await svc.repos.create({
    path: initGitRepo(),
    name: "me/kill-target-refused",
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$4" = "process-info" ]; then printf '%s' '{"result":{"process_info":{"foreground_process_group_id":999999}}}'; exit 0; fi`,
      `if [ "$4" = "close" ]; then printf '%s' '{"error":{"code":"confirmation_required","message":"closing this pane would close a worktree group"}}'; exit 1; fi`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  // See the previous test: mocked instead of signaling a real, unowned pid on the host.
  const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    await expect(
      svc.terminal.killAgent({
        repo: "me/kill-target-refused",
        paneId: "w1:p2",
      }),
    ).resolves.toEqual({ ok: true });
    expect(killSpy).toHaveBeenCalledWith(-999999, "SIGKILL");
  } finally {
    killSpy.mockRestore();
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.killAgent rejects an agent with no real pane id instead of shelling out", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/no-pane" });
  // Never touches PATH — asserts the guard runs before any herdr spawn is attempted.
  process.env.PATH = EMPTY_BIN;
  try {
    await expect(
      svc.terminal.killAgent({
        repo: "me/no-pane",
        paneId: `${String.fromCharCode(0)}idx:0`,
      }),
    ).rejects.toMatchObject({ status: 422 });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// A JSON-RPC caller can send any string as paneId (unlike tab/pane ids parsed from herdr's
// own stdout, which parseHerdrTabId/parseHerdrRootPaneId already validate) — killAgent must
// reject anything that doesn't look like a real herdr id before it reaches the argv.
test("terminal.killAgent rejects a paneId that doesn't look like a real herdr id", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/bad-pane-id" });
  process.env.PATH = EMPTY_BIN;
  try {
    for (const badId of ["-x", "--session", "w1 p2", "w1;rm"]) {
      await expect(
        svc.terminal.killAgent({ repo: "me/bad-pane-id", paneId: badId }),
      ).rejects.toMatchObject({ status: 422 });
    }
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.killAgent surfaces a visible error when herdr is not installed", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/no-herdr" });
  process.env.PATH = EMPTY_BIN;
  try {
    await expect(
      svc.terminal.killAgent({ repo: "me/no-herdr", paneId: "w1:p2" }),
    ).rejects.toMatchObject({
      status: 422,
      message: "herdr command not found on PATH",
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.cleanupClosedPullDevAgents closes workspaces for expired closed and merged PR agents only", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/closed-pr-cleanup",
  });
  const sessionName = herdrSessionName(repo);
  const old = new Date(Date.now() - 61 * 60 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const fresh = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const expiredMerged = S.createIssue(
    repo.id,
    "pull",
    "expired merged",
    "",
    "me",
  );
  S.createPull(expiredMerged.id, "loophub/pr-1", "main", null);
  S.registerAgentSession("session-expired-merged", "lh-dev", "external-1");
  S.setPullSession(expiredMerged.id, "session-expired-merged");
  S.setMerged(expiredMerged.id, "expired-merge-sha", "merge");
  db.run(`UPDATE pulls SET merged_at = ? WHERE issue_id = ?`, [
    old,
    expiredMerged.id,
  ]);

  const freshMerged = S.createIssue(repo.id, "pull", "fresh merged", "", "me");
  S.createPull(freshMerged.id, "loophub/pr-2", "main", null);
  S.registerAgentSession("session-fresh-merged", "lh-dev", "external-2");
  S.setPullSession(freshMerged.id, "session-fresh-merged");
  S.setMerged(freshMerged.id, "fresh-merge-sha", "merge");
  db.run(`UPDATE pulls SET merged_at = ? WHERE issue_id = ?`, [
    fresh,
    freshMerged.id,
  ]);

  const freshClosed = S.createIssue(repo.id, "pull", "fresh closed", "", "me");
  S.createPull(freshClosed.id, "loophub/pr-3", "main", null);
  S.registerAgentSession("session-fresh-closed", "lh-dev", "external-3");
  S.setPullSession(freshClosed.id, "session-fresh-closed");
  S.updateIssue(freshClosed.id, { state: "closed" });
  db.run(`UPDATE issues SET closed_at = ?, updated_at = ? WHERE id = ?`, [
    fresh,
    fresh,
    freshClosed.id,
  ]);

  const expiredClosed = S.createIssue(
    repo.id,
    "pull",
    "expired closed",
    "",
    "me",
  );
  S.createPull(expiredClosed.id, "loophub/pr-4", "main", null);
  S.registerAgentSession("session-expired-closed", "lh-dev", "external-4");
  S.setPullSession(expiredClosed.id, "session-expired-closed");
  S.updateIssue(expiredClosed.id, { state: "closed" });
  db.run(`UPDATE issues SET closed_at = ?, updated_at = ? WHERE id = ?`, [
    old,
    old,
    expiredClosed.id,
  ]);

  const unlinkedClosed = S.createIssue(
    repo.id,
    "pull",
    "unlinked closed",
    "",
    "me",
  );
  S.createPull(unlinkedClosed.id, "loophub/pr-5", "main", null);
  S.updateIssue(unlinkedClosed.id, { state: "closed" });
  db.run(`UPDATE issues SET closed_at = ?, updated_at = ? WHERE id = ?`, [
    old,
    old,
    unlinkedClosed.id,
  ]);

  const root = worktreeRoot();
  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          agent: "claude",
          agent_status: "working",
          name: "dev #1",
          pane_id: "wC:p1",
          workspace_id: "wC1",
          foreground_cwd: worktreePath(root, repo.full_name, 1),
        },
        {
          agent: "claude",
          agent_status: "working",
          name: "dev #2",
          pane_id: "wC:p2",
          workspace_id: "wC2",
          foreground_cwd: worktreePath(root, repo.full_name, 2),
        },
        {
          agent: "claude",
          agent_status: "working",
          name: "dev #3",
          pane_id: "wC:p3",
          workspace_id: "wC3",
          foreground_cwd: worktreePath(root, repo.full_name, 3),
        },
        {
          agent: "claude",
          agent_status: "working",
          name: "dev #4",
          pane_id: "wC:p4",
          workspace_id: "wC4",
          foreground_cwd: worktreePath(root, repo.full_name, 4),
        },
        {
          agent: "claude",
          agent_status: "working",
          name: "dev #5",
          pane_id: "wC:p5",
          workspace_id: "wC5",
          foreground_cwd: worktreePath(root, repo.full_name, 5),
        },
        {
          agent: "claude",
          agent_status: "working",
          name: "repo root",
          pane_id: "wR:p1",
          workspace_id: "wR",
          foreground_cwd: repo.local_path,
        },
      ],
    },
  });
  const CALLS_FILE = join(HOME, "closed-pr-cleanup-calls.txt");
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `echo "$@" >> ${CALLS_FILE}`,
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `printf '%s' '${agents}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    await expect(svc.terminal.cleanupClosedPullDevAgents()).resolves.toEqual({
      killed: 2,
      skipped: 3,
      failed: 0,
    });
    expect(killSpy).not.toHaveBeenCalled();
    const { readFileSync } = await import("node:fs");
    const calls = readFileSync(CALLS_FILE, "utf8");
    expect(calls).toContain(`--session ${sessionName} workspace close wC1`);
    expect(calls).toContain(`--session ${sessionName} workspace close wC4`);
    expect(calls).not.toContain("workspace close wC2");
    expect(calls).not.toContain("workspace close wC3");
    expect(calls).not.toContain("workspace close wC5");
    expect(calls).not.toContain("workspace close wR");
    expect(calls).not.toContain("pane process-info");
    expect(calls).not.toContain("pane close");

    const events = S.listEvents(0, repo.id, 10);
    const killed = events.filter((e) => e.type === "agent_session.killed");
    expect(killed).toHaveLength(2);
    expect(killed.map((e) => JSON.parse(e.payload).session_id).sort()).toEqual([
      "session-expired-closed",
      "session-expired-merged",
    ]);
  } finally {
    killSpy.mockRestore();
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.cleanupClosedPullDevAgents continues after invalid workspace ids and close failures", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/closed-pr-cleanup-failures",
  });
  const sessionName = herdrSessionName(repo);
  const old = new Date(Date.now() - 61 * 60 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const pulls = [
    "missing workspace",
    "invalid workspace",
    "failed close",
    "successful close",
    "valid duplicate after missing workspace",
  ].map((title, index) => {
    const prRow = S.createIssue(repo.id, "pull", title, "", "me");
    S.createPull(prRow.id, `loophub/pr-${prRow.number}`, "main", null);
    const sessionId = `session-cleanup-${index + 1}`;
    S.registerAgentSession(
      sessionId,
      "lh-dev",
      `failure-external-${index + 1}`,
    );
    S.setPullSession(prRow.id, sessionId);
    S.updateIssue(prRow.id, { state: "closed" });
    db.run(`UPDATE issues SET closed_at = ?, updated_at = ? WHERE id = ?`, [
      old,
      old,
      prRow.id,
    ]);
    return prRow;
  });
  const root = worktreeRoot();
  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const agents = JSON.stringify({
    result: {
      agents: [
        ...pulls.map((prRow, index) => ({
          agent: "claude",
          agent_status: "working",
          name: `dev #${prRow.number}`,
          pane_id: `wF:p${index + 1}`,
          workspace_id: [undefined, "--bad", "wFail", "wNext"][index],
          foreground_cwd: worktreePath(root, repo.full_name, prRow.number),
        })),
        {
          agent: "claude",
          agent_status: "working",
          name: `second dev #${pulls[4].number}`,
          pane_id: "wF:p6",
          workspace_id: "wRecovered",
          foreground_cwd: worktreePath(root, repo.full_name, pulls[4].number),
        },
      ],
    },
  });
  const CALLS_FILE = join(HOME, "closed-pr-cleanup-failure-calls.txt");
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `echo "$@" >> ${CALLS_FILE}`,
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `if [ "$3" = "agent" ]; then printf '%s' '${agents}'; exit 0; fi`,
      `if [ "$5" = "wFail" ]; then exit 1; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    await expect(svc.terminal.cleanupClosedPullDevAgents()).resolves.toEqual({
      killed: 2,
      skipped: 0,
      failed: 3,
    });
    expect(killSpy).not.toHaveBeenCalled();
    const calls = readFileSync(CALLS_FILE, "utf8");
    expect(calls).not.toContain("workspace close --bad");
    expect(calls).toContain(`--session ${sessionName} workspace close wFail`);
    expect(calls).toContain(`--session ${sessionName} workspace close wNext`);
    expect(calls).toContain(
      `--session ${sessionName} workspace close wRecovered`,
    );
    expect(calls).not.toContain("pane process-info");
    expect(calls).not.toContain("pane close");

    const events = S.listEvents(0, repo.id, 10);
    const killed = events.filter((e) => e.type === "agent_session.killed");
    expect(killed).toHaveLength(2);
    expect(killed.map((e) => JSON.parse(e.payload).session_id).sort()).toEqual([
      "session-cleanup-4",
      "session-cleanup-5",
    ]);
  } finally {
    killSpy.mockRestore();
    process.env.PATH = ORIGINAL_PATH;
  }
});

// #579: the issue-list Herdr badge's click action. Reuses `herdr agent focus` (#578's
// herdrAgentFocusArgv), the same one-call workspace+tab+pane focus the Resume dedup above
// already relies on.
test("terminal.focusAgent runs herdr agent focus scoped to the repo's session", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/focus-target",
  });
  const sessionName = herdrSessionName(repo);
  const CALLS_FILE = join(HOME, "focus-calls.txt");
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    ["#!/bin/sh", `echo "$@" >> ${CALLS_FILE}`, "exit 0"].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    await expect(
      svc.terminal.focusAgent({
        repo: "me/focus-target",
        paneId: "w4:p2",
      }),
    ).resolves.toEqual({ ok: true });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(CALLS_FILE, "utf8").trim()).toBe(
      `--session ${sessionName} agent focus w4:p2`,
    );
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// Like killAgent's paneId, this comes straight from an external JSON-RPC caller — reject
// anything that doesn't look like a real herdr id before it reaches the argv.
test("terminal.focusAgent rejects a paneId that doesn't look like a real herdr id", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/bad-focus-id" });
  process.env.PATH = EMPTY_BIN;
  try {
    for (const badId of ["-x", "--session", "w1 p2", "w1;rm"]) {
      await expect(
        svc.terminal.focusAgent({
          repo: "me/bad-focus-id",
          paneId: badId,
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.focusAgent requires repo and paneId", async () => {
  await expect(
    svc.terminal.focusAgent({ repo: "", paneId: "w4:p2" }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    svc.terminal.focusAgent({
      repo: "me/bad-focus-id",
      paneId: "",
    }),
  ).rejects.toMatchObject({ status: 422 });
});

test("terminal.focusAgent surfaces a visible error when herdr is not installed", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/no-herdr-focus" });
  process.env.PATH = EMPTY_BIN;
  try {
    await expect(
      svc.terminal.focusAgent({
        repo: "me/no-herdr-focus",
        paneId: "w4:p2",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "herdr command not found on PATH",
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sendAgentInput follows Herdr's positional text contract and submits each message", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/send-input",
  });
  const prRow = S.createIssue(repo.id, "pull", "open", "input PR", "me");
  S.createPull(prRow.id, `loophub/pr-${prRow.number}`, "main", null);
  const paneId = "wS:p2";
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          agent: "codex",
          agent_status: "idle",
          name: `dev #${prRow.number}`,
          pane_id: paneId,
          foreground_cwd: worktreePath(
            worktreeRoot(),
            repo.full_name,
            prRow.number,
          ),
        },
      ],
    },
  });
  const callsFile = join(HOME, "send-input-calls.bin");
  const injectedFile = join(HOME, "must-not-exist");
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$3" = "agent" ]; then printf '%s' '${agents}'; exit 0; fi`,
      // Herdr 0.7.1's contract is `send-text <pane_id> <text>`: it consumes $6 as
      // the text positional and ignores later arguments. Model that behavior so an
      // option terminator accidentally inserted before the text is observable.
      `printf '%s:%s\\0' "$4" "$6" >> ${callsFile}`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  const text = `--help; please inspect $(touch ${injectedFile}) ; then report`;
  try {
    await expect(
      svc.terminal.sendAgentInput({
        repo: repo.full_name,
        pull: prRow.number,
        paneId,
        text: "続けて",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      svc.terminal.sendAgentInput({
        repo: repo.full_name,
        pull: prRow.number,
        paneId,
        text: "-continue",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      svc.terminal.sendAgentInput({
        repo: repo.full_name,
        pull: prRow.number,
        paneId,
        text,
      }),
    ).resolves.toEqual({ ok: true });
    expect(readFileSync(callsFile).toString()).toBe(
      `send-text:続けて\0send-keys:Enter\0send-text:-continue\0send-keys:Enter\0send-text:${text}\0send-keys:Enter\0`,
    );
    expect(existsSync(injectedFile)).toBe(false);
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sendAgentInput rejects a pane that is not mapped to the requested PR", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/send-input-mismatch",
  });
  const prRow = S.createIssue(repo.id, "pull", "open", "input PR", "me");
  S.createPull(prRow.id, `loophub/pr-${prRow.number}`, "main", null);
  const agents = JSON.stringify({
    result: {
      agents: [
        {
          pane_id: "wM:p1",
          foreground_cwd: worktreePath(
            worktreeRoot(),
            repo.full_name,
            prRow.number,
          ),
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    ["#!/bin/sh", `printf '%s' '${agents}'`, ""].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    await expect(
      svc.terminal.sendAgentInput({
        repo: repo.full_name,
        pull: prRow.number,
        paneId: "wM:p9",
        text: "retry",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "The Herdr agent is no longer running for this PR",
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sendAgentInput reports a disappeared session and rejects blank input", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/send-input-gone",
  });
  const prRow = S.createIssue(repo.id, "pull", "open", "input PR", "me");
  S.createPull(prRow.id, `loophub/pr-${prRow.number}`, "main", null);

  await expect(
    svc.terminal.sendAgentInput({
      repo: repo.full_name,
      pull: prRow.number,
      paneId: "wG:p1",
      text: "   ",
    }),
  ).rejects.toMatchObject({ status: 422, message: "text is required" });
  await expect(
    svc.terminal.sendAgentInput({
      repo: repo.full_name,
      pull: 1.9,
      paneId: "wG:p1",
      text: "retry",
    }),
  ).rejects.toMatchObject({ status: 422, message: "pull is required" });
  await expect(
    svc.terminal.sendAgentInput({
      repo: repo.full_name,
      pull: prRow.number,
      paneId: "wG:p1",
      text: "first\nsecond",
    }),
  ).rejects.toMatchObject({
    status: 422,
    message: "text must be a single line",
  });

  writeFileSync(join(FAKE_BIN, "herdr"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    await expect(
      svc.terminal.sendAgentInput({
        repo: repo.full_name,
        pull: prRow.number,
        paneId: "wG:p1",
        text: "retry",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "The Herdr session is no longer available",
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// #602: `lh herdr`'s hierarchical workspace -> tab -> agent(PR) view.
test("herdr.tree builds the workspace/tab/agent hierarchy, matching an agent's cwd back to its PR", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/herdr-tree",
  });
  const sessionName = herdrSessionName(repo);
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, 20);

  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const workspaceList = JSON.stringify({
    result: {
      workspaces: [
        { workspace_id: "w1", label: "pr-20", number: 1 },
        { workspace_id: "w2", label: "loophub", number: 2 },
      ],
    },
  });
  const tabList = JSON.stringify({
    result: {
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", number: 1 },
        { tab_id: "w2:t1", workspace_id: "w2", number: 1 },
      ],
    },
  });
  const agentList = JSON.stringify({
    result: {
      agents: [
        {
          name: "dev #20",
          agent_status: "working",
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          foreground_cwd: prWorktree,
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `if [ "$3" = "workspace" ]; then printf '%s' '${workspaceList}'; exit 0; fi`,
      `if [ "$3" = "tab" ]; then printf '%s' '${tabList}'; exit 0; fi`,
      `if [ "$3" = "agent" ]; then printf '%s' '${agentList}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.herdr.tree({ repo: repo.full_name });
    expect(result).toEqual({
      session_name: sessionName,
      running: true,
      workspaces: [
        {
          id: "w1",
          label: "pr-20",
          number: 1,
          tabs: [
            {
              id: "w1:t1",
              number: 1,
              agents: [
                {
                  id: "w1:p2",
                  name: "dev #20",
                  status: "working",
                  pull: 20,
                },
              ],
            },
          ],
        },
        {
          id: "w2",
          label: "loophub",
          number: 2,
          tabs: [{ id: "w2:t1", number: 1, agents: [] }],
        },
      ],
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("herdr.tree reports running: false without querying workspace/tab/agent when the session isn't up yet", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/herdr-tree-not-running",
  });
  const sessionName = herdrSessionName(repo);
  const sessionList = JSON.stringify({
    sessions: [{ default: true, name: "default", running: true }],
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      "exit 1", // any --session <name> call fails the test if reached
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    expect(await svc.herdr.tree({ repo: repo.full_name })).toEqual({
      session_name: sessionName,
      running: false,
      workspaces: [],
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("herdr.tree reports running: false when herdr is not on PATH", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/herdr-tree-no-herdr",
  });
  process.env.PATH = EMPTY_BIN;
  try {
    expect(await svc.herdr.tree({ repo: repo.full_name })).toEqual({
      session_name: herdrSessionName(repo),
      running: false,
      workspaces: [],
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// Round-1 review finding: the session-list check can pass and then a follow-up call can still
// fail (session dies/errors mid-request) — that must degrade the same as "never running", not
// leak a raw ServiceError from runHerdr.
test("herdr.tree degrades to running: false when the session is confirmed running but a follow-up call fails", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/herdr-tree-race",
  });
  const sessionName = herdrSessionName(repo);
  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      "exit 1", // workspace/tab/agent list all fail, as if the session died mid-request
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    expect(await svc.herdr.tree({ repo: repo.full_name })).toEqual({
      session_name: sessionName,
      running: false,
      workspaces: [],
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// #602: `lh herdr focus <pr>`.
test("herdr.focus resolves the PR's running agent and focuses its pane", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/herdr-focus",
  });
  const sessionName = herdrSessionName(repo);
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, 20);
  const CALLS_FILE = join(HOME, "herdr-focus-calls.txt");

  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const agentList = JSON.stringify({
    result: {
      agents: [
        {
          name: "dev #20",
          agent_status: "working",
          pane_id: "w1:p2",
          foreground_cwd: prWorktree,
        },
      ],
    },
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `if [ "$4" = "focus" ]; then echo "$@" >> ${CALLS_FILE}; exit 0; fi`,
      `printf '%s' '${agentList}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    await expect(
      svc.herdr.focus({ repo: repo.full_name, pull: 20 }),
    ).resolves.toEqual({ ok: true, pane_id: "w1:p2" });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(CALLS_FILE, "utf8").trim()).toBe(
      `--session ${sessionName} agent focus w1:p2`,
    );
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("herdr.focus rejects with 404 when no running agent matches the PR", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/herdr-focus-no-match",
  });
  const sessionName = herdrSessionName(repo);
  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  const emptyAgents = JSON.stringify({ result: { agents: [] } });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      `printf '%s' '${emptyAgents}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    await expect(
      svc.herdr.focus({ repo: repo.full_name, pull: 99 }),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

// Same race as herdr.tree above: the session-list check passes, but the follow-up `agent list`
// call fails — this must report the same 422 "not running" error rather than a raw 500.
test("herdr.focus rejects with 422 when the session is confirmed running but the follow-up agent list call fails", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/herdr-focus-race",
  });
  const sessionName = herdrSessionName(repo);
  const sessionList = JSON.stringify({
    sessions: [{ default: false, name: sessionName, running: true }],
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      "exit 1", // agent list fails, as if the session died mid-request
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    await expect(
      svc.herdr.focus({ repo: repo.full_name, pull: 20 }),
    ).rejects.toMatchObject({
      status: 422,
      message: `herdr session "${sessionName}" is not running`,
    });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("herdr.focus rejects with 422 when the repo's herdr session isn't running", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/herdr-focus-not-running",
  });
  const sessionList = JSON.stringify({
    sessions: [{ default: true, name: "default", running: true }],
  });
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$1" = "session" ]; then printf '%s' '${sessionList}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    await expect(
      svc.herdr.focus({ repo: repo.full_name, pull: 20 }),
    ).rejects.toMatchObject({ status: 422 });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});
