import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "#loophub-test";

// A core of our own, as in core/herdr-core.test.ts: the tests never reach the user's core. The
// directory sits directly under /tmp because macOS caps socket paths at 103 bytes.
const HAS_HC = Bun.which("hc") !== null;
const DIR = mkdtempSync("/tmp/lhhs-");
const PREVIOUS_ENV = { ...process.env };
Object.assign(process.env, {
  HC_SESSION: "lhstatus",
  XDG_STATE_HOME: join(DIR, "s"),
  XDG_CONFIG_HOME: join(DIR, "c"),
  XDG_RUNTIME_DIR: join(DIR, "r"),
  LOOPHUB_HOME: join(DIR, "home"),
  LOOPHUB_DB: join(DIR, "home", "test.db"),
});
delete process.env.HC_SOCKET;
delete process.env.HC_TERMINAL_ID;
mkdirSync(join(DIR, "home"));

let S: typeof import("../store.ts");
let H: typeof import("./herdr-core-status.ts");
let svc: typeof import("../service.ts");
let C: typeof import("../herdr-core.ts");
let db: typeof import("../db.ts").db;
let repo: import("../store.ts").Repo;

beforeAll(async () => {
  S = await import("../store.ts");
  H = await import("./herdr-core-status.ts");
  svc = await import("../service.ts");
  C = await import("../herdr-core.ts");
  db = (await import("../db.ts")).db;
  repo = S.createRepo("me/status", join(DIR, "repo"));
});

afterAll(async () => {
  if (HAS_HC) await C.runHerdrCore(["server", "stop"]).catch(() => {});
  process.env = PREVIOUS_ENV;
  rmSync(DIR, { recursive: true, force: true });
});

function stateEvents() {
  return S.listEvents(0, repo.id, 500)
    .filter((row) => row.type === H.TERMINAL_AGENT_STATE_CHANGED_EVENT)
    .map((row) => JSON.parse(row.payload as unknown as string));
}

function terminal(address: string, overrides: object = {}) {
  return {
    address,
    state: "live",
    status: null,
    turn: 0,
    labels: {
      "loophub.repo": repo.full_name,
      "loophub.role": "executor",
      "loophub.pr": "7",
      "loophub.run": "3",
      "loophub.seq": "2",
    },
    ...overrides,
  };
}

test("an event updates the row and announces the change, once", () => {
  H.applyHerdrCoreEvent(repo, {
    type: "created",
    terminal: "t1",
    data: terminal("t1"),
  });
  const before = stateEvents().length;
  const status = {
    type: "status",
    terminal: "t1",
    data: { status: { state: "blocked", kind: "question" } },
  };
  H.applyHerdrCoreEvent(repo, status);
  H.applyHerdrCoreEvent(repo, status);
  expect(S.getHerdrCoreTerminal("t1")).toMatchObject({
    role: "executor",
    pr_number: 7,
    run_id: 3,
    seq: 2,
    state: "live",
    status: "blocked",
  });
  expect(stateEvents().length).toBe(before + 1);
  expect(stateEvents().at(-1)).toMatchObject({
    address: "t1",
    pr: 7,
    state: "live",
    status: "blocked",
  });

  H.applyHerdrCoreEvent(repo, {
    type: "turn",
    terminal: "t1",
    data: { state: null, turn: 4 },
  });
  expect(S.getHerdrCoreTerminal("t1")?.turn).toBe(4);
});

test("finished keeps the terminal apart from its status, and removed drops it", () => {
  H.applyHerdrCoreEvent(repo, {
    type: "finished",
    terminal: "t1",
    data: { exit_code: 3, reason: "exited", signal: null },
  });
  expect(S.getHerdrCoreTerminal("t1")).toMatchObject({
    state: "finished",
    status: null,
    exit_code: 3,
    reason: "exited",
  });
  H.applyHerdrCoreEvent(repo, { type: "removed", terminal: "t1", data: {} });
  expect(S.getHerdrCoreTerminal("t1")).toBeNull();
  expect(stateEvents().at(-1)).toMatchObject({
    address: "t1",
    state: "removed",
  });
});

test("events for an unknown terminal and uninteresting types change nothing", () => {
  const before = stateEvents().length;
  H.applyHerdrCoreEvent(repo, {
    type: "status",
    terminal: "t404",
    data: { status: { state: "working" } },
  });
  H.applyHerdrCoreEvent(repo, { type: "title", terminal: "t404", data: {} });
  expect(S.getHerdrCoreTerminal("t404")).toBeNull();
  expect(stateEvents().length).toBe(before);
});

test("a snapshot restores state, drops what it no longer lists, and is silent when unchanged", () => {
  H.applyHerdrCoreSnapshot(repo, [
    terminal("t2", { status: { state: "working" } }),
    terminal("t3"),
  ]);
  const snapshot = [terminal("t2", { status: { state: "done" }, turn: 1 })];
  H.applyHerdrCoreSnapshot(repo, snapshot);
  expect(S.getHerdrCoreTerminal("t2")).toMatchObject({
    status: "done",
    turn: 1,
  });
  expect(S.getHerdrCoreTerminal("t3")).toBeNull();

  const before = stateEvents().length;
  H.applyHerdrCoreSnapshot(repo, snapshot);
  expect(stateEvents().length).toBe(before);
  H.applyHerdrCoreSnapshot(repo, []);
});

test("a failed event rolls back the state change with it", () => {
  H.applyHerdrCoreSnapshot(repo, [terminal("t4")]);
  db.exec(`
    CREATE TEMP TRIGGER fail_state_event BEFORE INSERT ON events
    WHEN NEW.type = '${H.TERMINAL_AGENT_STATE_CHANGED_EVENT}'
    BEGIN SELECT RAISE(ABORT, 'injected'); END;
  `);
  try {
    expect(() =>
      H.applyHerdrCoreEvent(repo, {
        type: "status",
        terminal: "t4",
        data: { status: { state: "working" } },
      }),
    ).toThrowError(/injected/);
  } finally {
    db.exec("DROP TRIGGER fail_state_event");
  }
  expect(S.getHerdrCoreTerminal("t4")?.status).toBeNull();
  H.applyHerdrCoreSnapshot(repo, []);
});

describe("terminal/sessions", () => {
  test("shows live terminals in the herdr agent shape, without New Issue or finished ones", () => {
    H.applyHerdrCoreSnapshot(repo, [
      terminal("t5", { status: { state: "error" } }),
      terminal("t6", { state: "finished" }),
      terminal("t7", {
        labels: {
          "loophub.repo": repo.full_name,
          "loophub.role": "issue-create",
        },
      }),
      terminal("t8", {
        labels: {
          "loophub.repo": repo.full_name,
          "loophub.role": "orchestrator",
          "loophub.pr": "7",
          "loophub.run": "3",
        },
      }),
    ]);
    const sessions = svc.terminal.sessions();
    const group = sessions.repos.find((r) => r.repo === repo.full_name);
    // No herdr snapshot yet: unknown stays absent, or other repos would warn their session is down.
    expect(sessions.running_repos).toBeUndefined();
    expect(
      group?.agents.map((agent) => [agent.id, agent.name, agent.status]),
    ).toEqual([
      ["t5", "executor #3-2", "error"],
      ["t8", "orchestrator #3", ""],
    ]);
    expect(group?.agents[0]).toMatchObject({ pull: 7, focusable: false });
    expect(group?.pull_workspaces).toEqual([
      { pull: 7, pane_id: "t5", status: "error" },
    ]);
    H.applyHerdrCoreSnapshot(repo, []);
  });

  test("marks a run's agents so its tracker finds them, unless a relaunch replaced the parent", () => {
    const run = S.createWorkflowRun({
      workflowId: S.createWorkflow({
        name: "status-test",
        description: "",
        executePrompt: "",
        verifyPrompt: "",
      }).id,
      repoId: repo.id,
      issueNumber: 1,
      prNumber: 7,
      status: "running",
      currentStep: "execute",
      parentSessionId: "new-parent",
      costIncrementUsd: 0,
      costLimitUsd: 0,
    });
    S.registerHerdrPane({
      repoId: repo.id,
      launchId: "old-parent",
      sessionName: "herdr-core",
      paneId: "t11",
    });
    const labels = (role: string, seq?: string) => ({
      "loophub.repo": repo.full_name,
      "loophub.role": role,
      "loophub.pr": "7",
      "loophub.run": String(run.id),
      ...(seq ? { "loophub.seq": seq } : {}),
    });
    H.applyHerdrCoreSnapshot(repo, [
      terminal("t11", { labels: labels("orchestrator") }),
      terminal("t12", {
        status: { state: "working" },
        labels: labels("verifier", "1"),
      }),
    ]);
    const group = svc.terminal
      .sessions()
      .repos.find((r) => r.repo === repo.full_name);
    expect(group?.agents.map((agent) => [agent.name, agent.workflow])).toEqual([
      [`orchestrator #${run.id} (replaced)`, undefined],
      [
        `verifier #${run.id}-1`,
        { kind: "step", runId: run.id, step: "verify", sequence: 1 },
      ],
    ]);
    H.applyHerdrCoreSnapshot(repo, []);
  });

  test("adds a repo with herdr-core agents to a herdr session list that could be read", () => {
    S.recordHerdrSessionSnapshot(
      { repos: [], running_repos: ["other/repo"] },
      "read",
    );
    H.applyHerdrCoreSnapshot(repo, [terminal("t13")]);
    expect(svc.terminal.sessions().running_repos).toEqual([
      "other/repo",
      repo.full_name,
    ]);
    H.applyHerdrCoreSnapshot(repo, []);
  });

  test("joins a repo's herdr group instead of adding a second one", () => {
    S.recordHerdrSessionSnapshot(
      {
        repos: [
          {
            repo: repo.full_name,
            session_name: "herdr-session",
            agents: [
              {
                id: "w1:p1",
                name: "dev",
                status: "idle",
                pull: null,
                pull_closed: false,
                focusable: true,
              },
            ],
            pull_workspaces: [],
            issue_workspaces: [],
          },
        ],
        running_repos: [repo.full_name],
      },
      "signature",
    );
    H.applyHerdrCoreSnapshot(repo, [terminal("t9")]);
    const sessions = svc.terminal.sessions();
    expect(sessions.repos).toHaveLength(1);
    expect(sessions.repos[0].session_name).toBe("herdr-session");
    expect(sessions.repos[0].agents.map((agent) => agent.id)).toEqual([
      "w1:p1",
      "t9",
    ]);
    expect(sessions.running_repos).toEqual([repo.full_name]);
    H.applyHerdrCoreSnapshot(repo, []);
  });
});

test("only a repo on herdr-core or with a live terminal is followed", () => {
  expect(svc.terminal.herdrCoreFollowedRepos()).toEqual([]);
  H.applyHerdrCoreSnapshot(repo, [terminal("t10")]);
  expect(svc.terminal.herdrCoreFollowedRepos().map((r) => r.id)).toEqual([
    repo.id,
  ]);
  H.applyHerdrCoreSnapshot(repo, [terminal("t10", { state: "finished" })]);
  expect(svc.terminal.herdrCoreFollowedRepos()).toEqual([]);
  H.applyHerdrCoreSnapshot(repo, []);
});

describe.skipIf(!HAS_HC)("against an isolated core", () => {
  async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await Bun.sleep(50);
    }
  }

  test("follows status and finish, and a resubscribe restores what happened while away", async () => {
    // The program's own report (OSC 7501), then a wait for a line on its input.
    const script = join(DIR, "agent.sh");
    writeFileSync(
      script,
      `printf '\\033]7501;state=working\\033\\\\'\nread line\nprintf '\\033]7501;state=done\\033\\\\'\nread line\nexit 3\n`,
    );
    const labels = {
      "loophub.repo": repo.full_name,
      "loophub.role": "executor",
      "loophub.pr": "7",
    };
    let follow = svc.terminal.followHerdrCoreRepo(repo);
    const { address } = (await C.callHerdrCore("terminal.run", {
      argv: ["sh", script],
      labels,
      no_parent: true,
      no_notify: true,
    })) as { address: string };

    await until(() => S.getHerdrCoreTerminal(address)?.status === "working");
    expect(stateEvents().at(-1)).toMatchObject({ address, status: "working" });

    // A restarted core ends the stream on its own, and that is all the worker needs to resubscribe.
    await C.runHerdrCore(["server", "restart"]);
    await follow.done;

    // Unobserved: nothing is following while the program moves on.
    await C.callHerdrCore("terminal.send", { terminal: address, text: "go" });
    await until(() => {
      const row = Bun.spawnSync(["hc", "get", address]).stdout.toString();
      return row.includes('"done"');
    });
    expect(S.getHerdrCoreTerminal(address)?.status).toBe("working");

    follow = svc.terminal.followHerdrCoreRepo(repo);
    await until(() => S.getHerdrCoreTerminal(address)?.status === "done");

    await C.callHerdrCore("terminal.send", { terminal: address, text: "go" });
    await until(() => S.getHerdrCoreTerminal(address)?.state === "finished");
    expect(S.getHerdrCoreTerminal(address)).toMatchObject({
      status: null,
      exit_code: 3,
    });

    // A finished terminal is still in the next snapshot, so it stays recorded as finished.
    follow.stop();
    await follow.done;
    follow = svc.terminal.followHerdrCoreRepo(repo);
    await Bun.sleep(300);
    expect(S.getHerdrCoreTerminal(address)?.state).toBe("finished");
    follow.stop();
    await follow.done;
  }, 40_000);

  test("a stopped subscription ends quietly", async () => {
    const follow = svc.terminal.followHerdrCoreRepo(repo);
    follow.stop();
    await expect(follow.done).resolves.toBeUndefined();
  });
});

describe("terminal/pullTerminals", () => {
  function row(
    address: string,
    overrides: Partial<import("../store.ts").HerdrCoreTerminalState>,
  ) {
    S.upsertHerdrCoreTerminal({
      address,
      repo_id: dockRepo.id,
      role: "executor",
      pr_number: 7,
      run_id: 1,
      seq: 1,
      state: "live",
      status: null,
      turn: 0,
      exit_code: null,
      reason: null,
      session_id: null,
      ...overrides,
    });
  }
  let dockRepo: import("../store.ts").Repo;

  beforeAll(() => {
    dockRepo = S.createRepo("me/dock", join(DIR, "dock"));
    S.setRepoTerminalBackend(dockRepo.id, "herdr-core");
    row("t1", { role: "orchestrator", seq: null, status: "working" });
    row("t2", { seq: 1, state: "finished" });
    row("t3", { role: "verifier", seq: 2, status: "done" });
    row("t4", { seq: 3, status: "blocked" });
    // Neither on this PR, nor a Workflow agent, nor in a run.
    row("t5", { pr_number: 8 });
    row("t6", { role: "github-pr-export", run_id: null, seq: null });
  });

  test("lists live agents in run order, numbering each role across finished ones", () => {
    expect(svc.terminal.pullTerminals({ repo: "me/dock", pull: 7 })).toEqual({
      terminals: [
        {
          address: "t1",
          label: "orchestrator",
          status: "working",
          closable: false,
        },
        {
          address: "t3",
          label: "verifier #1",
          status: "done",
          closable: false,
        },
        {
          address: "t4",
          label: "executor #2",
          status: "blocked",
          closable: false,
        },
      ],
      lost: [],
      shell_blocker: "This pull request has no worktree",
    });
  });

  test("lists the PR's shells after its agents, numbered across finished ones", () => {
    const shell = { role: "shell", run_id: null, seq: null } as const;
    row("s1", { ...shell, state: "finished" });
    row("s2", { ...shell, status: "working" });
    row("s3", { ...shell, pr_number: 8 });
    expect(
      svc.terminal
        .pullTerminals({ repo: "me/dock", pull: 7 })
        .terminals.map(({ label, closable }) => [label, closable]),
    ).toEqual([
      ["orchestrator", false],
      ["verifier #1", false],
      ["executor #2", false],
      ["shell 2", true],
    ]);
    for (const address of ["s1", "s2", "s3"])
      S.deleteHerdrCoreTerminal(address);
  });

  test("lets the dock open a shell only once the PR has a worktree", async () => {
    const { worktreeRoot } = await import("../config.ts");
    const { worktreePath } = await import("../worktree-path.ts");
    const pr = S.createIssue(dockRepo.id, "pull", "shell", "", "me");
    S.createPull(pr.id, `loophub-p${pr.number}`, "main", null);
    const blocker = () =>
      svc.terminal.pullTerminals({ repo: "me/dock", pull: pr.number })
        .shell_blocker;
    expect(blocker()).toBe("This pull request has no worktree");
    await expect(
      svc.terminal.openPullShell({ repo: "me/dock", pull: pr.number }),
    ).rejects.toMatchObject({
      status: 422,
      message: "This pull request has no worktree",
    });
    mkdirSync(worktreePath(worktreeRoot(), "me/dock", pr.number), {
      recursive: true,
    });
    expect(blocker()).toBeNull();
  });

  test("lists lost agents under the same numbering, and a restored terminal keeps its number", () => {
    const lost = (seq: number | null, role: "executor" | "verifier") => ({
      run_id: 1,
      role,
      seq,
      session_id: `s${seq}`,
      restore_blocker: null,
    });
    // verifier #1 (seq 2) lost with its row gone; a restored executor #1 (seq 1) runs again in t9.
    expect(
      H.listPullTerminals(dockRepo, 7, [lost(5, "verifier")]).lost,
    ).toEqual([
      { session_id: "s5", label: "verifier #2", restore_blocker: null },
    ]);
    row("t9", { seq: 1, status: "working" });
    expect(H.listPullTerminals(dockRepo, 7).terminals).toContainEqual({
      address: "t9",
      label: "executor #1",
      status: "working",
      closable: false,
    });
    S.deleteHerdrCoreTerminal("t9");
  });

  test("names the run once a PR has several", () => {
    row("t7", { role: "orchestrator", pr_number: 9, seq: null });
    row("t8", { role: "orchestrator", pr_number: 9, run_id: 2, seq: null });
    expect(
      svc.terminal
        .pullTerminals({ repo: "me/dock", pull: 9 })
        .terminals.map((terminal) => terminal.label),
    ).toEqual(["run 1 · orchestrator", "run 2 · orchestrator"]);
  });

  test("is empty unless the repo runs on herdr-core", () => {
    expect(
      svc.terminal.pullTerminals({ repo: repo.full_name, pull: 7 }).terminals,
    ).toEqual([]);
  });
});

describe("terminal/issueTerminals", () => {
  let issueRepo: import("../store.ts").Repo;

  function row(
    address: string,
    overrides: Partial<import("../store.ts").HerdrCoreTerminalState> = {},
  ) {
    S.upsertHerdrCoreTerminal({
      address,
      repo_id: issueRepo.id,
      role: "issue-create",
      pr_number: null,
      run_id: null,
      seq: null,
      state: "live",
      status: null,
      turn: 0,
      exit_code: null,
      reason: null,
      session_id: null,
      ...overrides,
    });
  }

  beforeAll(() => {
    issueRepo = S.createRepo("me/issue-dock", join(DIR, "issue-dock"));
    S.setRepoTerminalBackend(issueRepo.id, "herdr-core");
  });

  test("lists this repo's live New issue terminals, numbering across finished ones", () => {
    row("t21", { status: "working" });
    row("t22", { state: "finished" });
    row("t23");
    row("t24", { role: "github-pr-export" });
    row("t25", { role: "executor", pr_number: 7, run_id: 1, seq: 1 });
    expect(svc.terminal.issueTerminals({ repo: "me/issue-dock" })).toEqual({
      terminals: [
        {
          address: "t21",
          label: "New issue 1",
          status: "working",
          closable: true,
        },
        {
          address: "t23",
          label: "New issue 3",
          status: null,
          closable: true,
        },
      ],
    });
  });

  test("is empty unless the repo runs on herdr-core", () => {
    const other = S.createRepo("me/issue-herdr", join(DIR, "issue-herdr"));
    S.upsertHerdrCoreTerminal({
      address: "t26",
      repo_id: other.id,
      role: "issue-create",
      pr_number: null,
      run_id: null,
      seq: null,
      state: "live",
      status: null,
      turn: 0,
      exit_code: null,
      reason: null,
      session_id: null,
    });
    expect(svc.terminal.issueTerminals({ repo: "me/issue-herdr" })).toEqual({
      terminals: [],
    });
  });

  test("the launcher's record lists a terminal at once, and never overwrites the worker's", () => {
    H.recordIssueTerminalStarted(issueRepo, "t27", "s27");
    expect(S.getHerdrCoreTerminal("t27")).toMatchObject({
      role: "issue-create",
      state: "live",
      session_id: "s27",
    });
    expect(
      S.listEvents(0, issueRepo.id, 500)
        .filter((event) => event.type === H.TERMINAL_AGENT_STATE_CHANGED_EVENT)
        .map((event) => JSON.parse(event.payload as unknown as string))
        .at(-1),
    ).toMatchObject({ address: "t27", role: "issue-create" });

    row("t28", { state: "finished" });
    H.recordIssueTerminalStarted(issueRepo, "t28", "s28");
    expect(S.getHerdrCoreTerminal("t28")?.state).toBe("finished");
  });

  test("with an issue, lists only the live terminals it was filed from", () => {
    const filed = S.createIssue(issueRepo.id, "issue", "filed", "", "me");
    const elsewhere = S.createIssue(issueRepo.id, "issue", "other", "", "me");
    const loose = S.createIssue(issueRepo.id, "issue", "loose", "", "me");
    function fileFrom(issue: import("../store.ts").IssueRow, address: string) {
      const launchId = `launch-${address}`;
      S.registerHerdrPane({
        repoId: issueRepo.id,
        launchId,
        paneId: address,
        sessionName: "herdr-core",
        origin: "issue-create",
      });
      S.linkIssueFiledFromHerdrPane({
        repoId: issueRepo.id,
        launchId,
        issueId: issue.id,
      });
    }
    row("t31");
    row("t32");
    row("t33", { state: "finished" });
    fileFrom(filed, "t31");
    fileFrom(elsewhere, "t32");
    fileFrom(elsewhere, "t33");
    const issueTerminals = (issue: number) =>
      svc.terminal.issueTerminals({ repo: "me/issue-dock", issue }).terminals;
    const all = svc.terminal.issueTerminals({
      repo: "me/issue-dock",
    }).terminals;

    expect(issueTerminals(filed.number)).toEqual(
      all.filter((t) => t.address === "t31"),
    );
    expect(issueTerminals(elsewhere.number).map((t) => t.address)).toEqual([
      "t32",
    ]);
    expect(issueTerminals(loose.number)).toEqual([]);
    expect(all.map((t) => t.address)).toEqual(
      expect.arrayContaining(["t31", "t32"]),
    );
  });

  test("numbers tabs in start order, whatever the addresses sort to", () => {
    row("tz");
    row("t9");
    const labels = new Map(
      svc.terminal
        .issueTerminals({ repo: "me/issue-dock" })
        .terminals.map((t) => [t.address, t.label]),
    );
    const number = (address: string) =>
      Number(labels.get(address)?.replace("New issue ", ""));
    expect(number("t9")).toBe(number("tz") + 1);
  });
});

describe("New issue history", () => {
  const CLAUDE_SESSION = "11111111-1111-4111-8111-111111111111";
  const CODEX_SESSION = "22222222-2222-4222-8222-222222222222";
  const LIVE_SESSION = "33333333-3333-4333-8333-333333333333";
  // A Claude Code session whose transcript is gone (expired, or never written).
  const EXPIRED_SESSION = "55555555-5555-4555-8555-555555555555";
  let historyRepo: import("../store.ts").Repo;

  function session(
    id: string,
    runtime: string,
    name = "New issue (me/history)",
  ) {
    S.registerAgentSession(
      id,
      "issue-create",
      id,
      name,
      runtime,
      "issue-create",
    );
  }

  beforeAll(() => {
    historyRepo = S.createRepo("me/history", join(DIR, "history"));
    S.setRepoTerminalBackend(historyRepo.id, "herdr-core");
    session(CLAUDE_SESSION, "claude-code");
    session(CODEX_SESSION, "codex");
    session(LIVE_SESSION, "claude-code");
    // Another repo's New issue, and a session of another kind.
    session(
      "44444444-4444-4444-8444-444444444444",
      "claude-code",
      "New issue (me/other)",
    );
    S.registerAgentSession(
      "dev-1",
      "lh-dev",
      "dev-1",
      "New issue (me/history)",
      "claude-code",
      "dev",
    );
    const filed = S.createIssue(
      historyRepo.id,
      "issue",
      "Filed by New issue",
      "",
      "me",
    );
    S.linkSession(CLAUDE_SESSION, filed.id);
    H.recordIssueTerminalStarted(historyRepo, "t41", LIVE_SESSION);
    session(EXPIRED_SESSION, "claude-code");
    process.env.HOME = join(DIR, "home-dir");
    const project = join(DIR, "home-dir", ".claude", "projects", "-history");
    mkdirSync(project, { recursive: true });
    for (const id of [CLAUDE_SESSION, LIVE_SESSION])
      writeFileSync(join(project, `${id}.jsonl`), "{}\n");
  });

  test("lists the repo's New issue sessions except those a live terminal runs", () => {
    const sessions = svc.terminal.issueTerminalHistory({
      repo: "me/history",
    }).sessions;
    expect(
      sessions
        .map((row) => ({
          session_id: row.session_id,
          issue: row.issue,
          restore_blocker: row.restore_blocker,
        }))
        .sort((a, b) => a.session_id.localeCompare(b.session_id)),
    ).toEqual([
      {
        session_id: CLAUDE_SESSION,
        issue: { number: 1, title: "Filed by New issue" },
        restore_blocker: null,
      },
      {
        session_id: CODEX_SESSION,
        issue: null,
        restore_blocker: "Restore is available for Claude Code only",
      },
      {
        session_id: EXPIRED_SESSION,
        issue: null,
        restore_blocker: "The conversation is no longer saved",
      },
    ]);
  });

  test("a finished terminal's session is listed again", () => {
    S.upsertHerdrCoreTerminal({
      ...(S.getHerdrCoreTerminal(
        "t41",
      ) as import("../store.ts").HerdrCoreTerminalRow),
      state: "finished",
    });
    expect(
      svc.terminal
        .issueTerminalHistory({ repo: "me/history" })
        .sessions.map((row) => row.session_id),
    ).toContain(LIVE_SESSION);
  });

  test("the worker reads a terminal's session from its label", () => {
    H.applyHerdrCoreEvent(historyRepo, {
      type: "created",
      terminal: "t42",
      data: {
        address: "t42",
        state: "live",
        labels: {
          "loophub.repo": "me/history",
          "loophub.role": "issue-create",
          "loophub.session": CLAUDE_SESSION,
        },
      },
    });
    expect(S.getHerdrCoreTerminal("t42")?.session_id).toBe(CLAUDE_SESSION);
  });

  test("restore refuses a runtime other than Claude Code, and another repo's session", async () => {
    await expect(
      svc.terminal.restoreIssueTerminal({
        repo: "me/history",
        sessionId: CODEX_SESSION,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Claude Code only"),
    });
    await expect(
      svc.terminal.restoreIssueTerminal({
        repo: "me/history",
        sessionId: "44444444-4444-4444-8444-444444444444",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("restore refuses a session whose transcript is gone, before starting a terminal", async () => {
    await expect(
      svc.terminal.restoreIssueTerminal({
        repo: "me/history",
        sessionId: EXPIRED_SESSION,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "The conversation is no longer saved",
    });
    expect(
      S.listHerdrCoreTerminalRows(historyRepo.id).some(
        (row) => row.session_id === EXPIRED_SESSION,
      ),
    ).toBe(false);
  });

  test("restore refuses a session a live terminal already runs", async () => {
    await expect(
      svc.terminal.restoreIssueTerminal({
        repo: "me/history",
        sessionId: CLAUDE_SESSION,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
