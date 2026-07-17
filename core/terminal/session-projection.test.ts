import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-session-projection-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let projectHerdrRepoSessions: typeof import("./session-projection.ts").projectHerdrRepoSessions;
let worktreeRoot: () => string;
let worktreePath: (root: string, fullName: string, pr: number) => string;

// The projection never runs herdr: it takes that session's `agent list` output as a string, so
// these tests need no fake binary on PATH. The name is opaque to it — any stable string works.
const SESSION = "session-projection-test";

function initGitRepo(): string {
  const path = mkdtempSync(join(HOME, "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  return path;
}

function agentList(agents: unknown[]): string {
  return JSON.stringify({ result: { agents } });
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  ({ projectHerdrRepoSessions } = await import("./session-projection.ts"));
  ({ worktreeRoot } = await import("../config.ts"));
  ({ worktreePath } = await import("../worktree-path.ts"));
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("projectHerdrRepoSessions drops a group with no agents at all", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/no-agents",
  });
  expect(
    projectHerdrRepoSessions(repo, SESSION, agentList([]), worktreeRoot()),
  ).toBeNull();
});

test("projectHerdrRepoSessions hides New Issue agents but keeps normal repo-root agents", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/new-issue-hidden",
  });
  const openPr = S.createIssue(repo.id, "pull", "open", "", "me");
  S.createPull(openPr.id, "loophub/pr-1", "main", null);

  S.upsertIssueHerdrPane({
    launchId: "launch-new-issue",
    repoId: repo.id,
    paneId: "wN:p1",
    sessionName: SESSION,
  });

  const out = agentList([
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
  ]);

  expect(projectHerdrRepoSessions(repo, SESSION, out, worktreeRoot())).toEqual({
    repo: "me/new-issue-hidden",
    session_name: SESSION,
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
  });
});

test("projectHerdrRepoSessions drops a group whose only agents are New Issue panes", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/new-issue-only",
  });
  const out = agentList([
    {
      agent: "claude",
      agent_status: "working",
      name: "New issue",
      pane_id: "wX:p1",
      foreground_cwd: repo.local_path,
    },
  ]);
  expect(
    projectHerdrRepoSessions(repo, SESSION, out, worktreeRoot()),
  ).toBeNull();
});

// #579: the issue-list Herdr badge needs to know which PR a running agent's terminal belongs
// to. The projection resolves that from the same `agent list` output, without an extra herdr
// shellout, by matching an agent's foreground_cwd against the PR's deterministic worktree path.
test("projectHerdrRepoSessions maps a running agent's cwd back to its PR (#579)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/pull-workspace",
  });
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, 12);
  const out = agentList([
    {
      agent: "claude",
      agent_status: "working",
      name: "Issue #9 - PR 12",
      pane_id: "wP:p2",
      cwd: "/some/repo/root",
      foreground_cwd: prWorktree,
    },
  ]);

  expect(projectHerdrRepoSessions(repo, SESSION, out, worktreeRoot())).toEqual({
    repo: "me/pull-workspace",
    session_name: SESSION,
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
  });
});

test("projectHerdrRepoSessions maps ordinary panes to their exact persisted sessions", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/ordinary-pane-sessions",
  });
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
      sessionName: SESSION,
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
    sessionName: SESSION,
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

  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);
  const out = agentList([
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
  ]);

  const group = projectHerdrRepoSessions(repo, SESSION, out, worktreeRoot());
  expect(group?.agents).toMatchObject([
    {
      id: "wO:p1",
      session: { id: oldSession, usage: { total_tokens: 150, cost_usd: 1.25 } },
    },
    {
      id: "wO:p2",
      session: { id: newSession, usage: { total_tokens: 300, cost_usd: 2.5 } },
    },
    { id: "wO:p3" },
  ]);
  expect(group?.agents[2]).not.toHaveProperty("session");
});

// A pane registered under a *different* herdr session name must not resolve: the same pane id can
// be reused across sessions, so the projection matches on both (session_name is why it takes one).
test("projectHerdrRepoSessions ignores a pane registered under another herdr session", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/other-session-pane",
  });
  const pr = S.createIssue(repo.id, "pull", "the PR", "", "me");
  S.createPull(pr.id, `loophub/pr-${pr.number}`, "main", null);
  const sessionId = "other-session-dev";
  S.registerAgentSession(
    sessionId,
    "lh-build",
    sessionId,
    null,
    "codex",
    "dev",
  );
  S.registerHerdrPane({
    repoId: repo.id,
    launchId: sessionId,
    paneId: "wR:p1",
    sessionName: "a-different-herdr-session",
    displayName: "dev pane",
    origin: "build",
  });
  S.linkHerdrPaneResource({
    repoId: repo.id,
    launchId: sessionId,
    resourceKind: "pull",
    resourceKey: String(pr.number),
  });

  const out = agentList([
    {
      name: "dev pane",
      agent_status: "working",
      pane_id: "wR:p1",
      foreground_cwd: worktreePath(worktreeRoot(), repo.full_name, pr.number),
    },
  ]);
  const group = projectHerdrRepoSessions(repo, SESSION, out, worktreeRoot());
  expect(group?.agents[0]).not.toHaveProperty("session");
});

test("projectHerdrRepoSessions enriches Workflow panes with hierarchy and session usage", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/workflow-pane-details",
  });
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

  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);
  const out = agentList([
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
  ]);

  const group = projectHerdrRepoSessions(repo, SESSION, out, worktreeRoot());
  expect(group?.agents).toMatchObject([
    {
      id: "wW:p1",
      workflow: { kind: "parent", runId: run.id },
      session: { id: parentSession, runtime: "codex" },
    },
    {
      id: "wW:p2",
      workflow: { kind: "step", runId: run.id, step: "execute", sequence: 1 },
      session: {
        id: executeSession,
        usage: { total_tokens: 150, cost_usd: 1.25 },
      },
    },
    {
      id: "wW:p3",
      workflow: { kind: "step", runId: run.id, step: "verify", sequence: 2 },
      session: { id: verifySession },
    },
    {
      id: "wW:p4",
      workflow: { kind: "step", runId: run.id, step: "execute", sequence: 4 },
      session: { id: latestExecuteSession },
    },
    {
      id: "wW:p5",
      workflow: { kind: "step", runId: run.id, step: "verify", sequence: 0 },
    },
    {
      id: "wW:p9",
      workflow: { kind: "step", runId: run.id, step: "execute", sequence: 0 },
      session: { id: fallbackExecuteSession },
    },
    {
      id: "wW:p6",
      workflow: { kind: "parent", runId: run.id },
      session: { id: parentSession, runtime: "codex" },
    },
    {
      id: "wW:p7",
      workflow: { kind: "step", runId: run.id, step: "execute", sequence: 0 },
      session: { id: legacyExecuteSession },
    },
    {
      id: "wW:p8",
      workflow: { kind: "step", runId: run.id, step: "verify", sequence: 0 },
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
});

// #821: the issue-detail Agents section needs each running agent keyed back to the *issue* its PR
// closes, not just the PR. The projection composes cwd→PR (as in #579 above) with the PR's
// linked_issue_id (recorded when `lh build` opened the PR) to fill issue_workspaces.
test("projectHerdrRepoSessions maps a running agent's PR back to its linked issue (#821)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/issue-workspace",
  });
  // Sequential numbers per repo: #1 = the issue, #2 = the PR that closes it. The PR is created
  // directly in the store (a bare temp repo has no head branch for pulls.create) and linked to the
  // issue via linked_issue_id, mirroring what `lh build` records when it opens the PR.
  const issue = S.createIssue(repo.id, "issue", "the issue", "", "me");
  const pr = S.createIssue(repo.id, "pull", "the PR", "", "me");
  // createPull(issueId, head, base, headSha, linkedIssueId): the issue link is the 5th arg.
  S.createPull(pr.id, "loophub/pr-2", "main", null, issue.id);
  const prWorktree = worktreePath(worktreeRoot(), repo.full_name, pr.number);

  const out = agentList([
    {
      agent: "claude",
      agent_status: "working",
      name: `dev #${pr.number}`,
      pane_id: "wI:p2",
      foreground_cwd: prWorktree,
    },
  ]);

  expect(projectHerdrRepoSessions(repo, SESSION, out, worktreeRoot())).toEqual({
    repo: "me/issue-workspace",
    session_name: SESSION,
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
    pull_workspaces: [{ pull: pr.number, pane_id: "wI:p2", status: "working" }],
    issue_workspaces: [
      { issue: issue.number, pane_id: "wI:p2", status: "working" },
    ],
  });
});

// #611: the sidebar grays out agents whose worktree PR is finished. The projection resolves each
// agent's cwd to a PR (same placement parse as #602) and flags the ones whose PR is merged or
// closed; an open PR, an unknown pr-<n> dir, and a repo-root cwd all stay unflagged.
test("projectHerdrRepoSessions flags agents whose worktree PR is merged or closed (#611)", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/stale-agents",
  });
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
  const out = agentList([
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
  ]);

  const group = projectHerdrRepoSessions(repo, SESSION, out, root);
  expect(group?.agents).toEqual([
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
});
