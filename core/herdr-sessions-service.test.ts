import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
// Persisted agent label used by sessions created before Workflow replaced the lh-dev launcher.
const LEGACY_LH_DEV_SESSION_AGENT = "lh-dev";
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

// terminal.sessions is now a pure DB read of the worker-owned snapshot (#1665): the herdr capture
// and projection run in snapshotHerdrSessions. Drive that first, then read the persisted snapshot,
// dropping the captured_at freshness stamp the RPC adds so the projection assertions stay focused.
async function snapshotAndReadSessions() {
  await svc.terminal.snapshotHerdrSessions();
  const result = svc.terminal.sessions();
  delete (result as { captured_at?: string | null }).captured_at;
  return result;
}

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
    const result = await snapshotAndReadSessions();
    expect(result.running_repos).toEqual([
      "me/with-agents",
      "me/agentless",
      "me/agent-list-failure",
    ]);
    // me/agent-list-failure could not be captured at all, and says so instead of passing for a
    // repo with no agents (#2142). It has no group here only because no earlier snapshot ever
    // captured it — otherwise its last known agents would be carried over.
    expect(result.capture_failed_repos).toEqual(["me/agent-list-failure"]);
    // me/agentless runs a session with zero agents and me/not-running has no session —
    // neither produces a group, and neither is reported as a capture failure.
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

test("terminal.sessions is empty when herdr is not on PATH", async () => {
  process.env.PATH = EMPTY_BIN;
  try {
    expect(await snapshotAndReadSessions()).toEqual({ repos: [] });
  } finally {
    process.env.PATH = ORIGINAL_PATH;
  }
});

test("terminal.sessions is empty when herdr exits non-zero", async () => {
  writeFileSync(join(FAKE_BIN, "herdr"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    expect(await snapshotAndReadSessions()).toEqual({ repos: [] });
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
    expect(await snapshotAndReadSessions()).toEqual({
      repos: [],
      running_repos: [],
    });

    writeFileSync(
      join(FAKE_BIN, "herdr"),
      "#!/bin/sh\nprintf '%s' 'not-json'\n",
    );
    expect(await snapshotAndReadSessions()).toEqual({ repos: [] });

    writeFileSync(
      join(FAKE_BIN, "herdr"),
      `#!/bin/sh\nprintf '%s' '${JSON.stringify({ sessions: [{ running: true }, 42] })}'\n`,
    );
    expect(await snapshotAndReadSessions()).toEqual({ repos: [] });
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
  S.registerAgentSession(
    "session-expired-merged",
    LEGACY_LH_DEV_SESSION_AGENT,
    "external-1",
  );
  S.setPullSession(expiredMerged.id, "session-expired-merged");
  S.setMerged(expiredMerged.id, "expired-merge-sha", "merge");
  db.run(`UPDATE pulls SET merged_at = ? WHERE issue_id = ?`, [
    old,
    expiredMerged.id,
  ]);

  // Merged but not yet past the grace window, so it must be skipped — the grace/eligibility
  // arithmetic itself is unit-tested in core/terminal/herdr-cleanup.test.ts.
  const freshMerged = S.createIssue(repo.id, "pull", "fresh merged", "", "me");
  S.createPull(freshMerged.id, "loophub/pr-2", "main", null);
  S.registerAgentSession(
    "session-fresh-merged",
    LEGACY_LH_DEV_SESSION_AGENT,
    "external-2",
  );
  S.setPullSession(freshMerged.id, "session-fresh-merged");
  S.setMerged(freshMerged.id, "fresh-merge-sha", "merge");
  db.run(`UPDATE pulls SET merged_at = ? WHERE issue_id = ?`, [
    fresh,
    freshMerged.id,
  ]);

  const expiredClosed = S.createIssue(
    repo.id,
    "pull",
    "expired closed",
    "",
    "me",
  );
  S.createPull(expiredClosed.id, "loophub/pr-3", "main", null);
  S.registerAgentSession(
    "session-expired-closed",
    LEGACY_LH_DEV_SESSION_AGENT,
    "external-3",
  );
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
  S.createPull(unlinkedClosed.id, "loophub/pr-4", "main", null);
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
      skipped: 2,
      failed: 0,
    });
    expect(killSpy).not.toHaveBeenCalled();
    const { readFileSync } = await import("node:fs");
    const calls = readFileSync(CALLS_FILE, "utf8");
    expect(calls).toContain(`--session ${sessionName} workspace close wC1`);
    expect(calls).toContain(`--session ${sessionName} workspace close wC3`);
    expect(calls).not.toContain("workspace close wC2");
    expect(calls).not.toContain("workspace close wC4");
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
      LEGACY_LH_DEV_SESSION_AGENT,
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

test("terminal.sendAgentInput delivers to the verified pane and reports the failing phase", async () => {
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
  const pendingFile = join(HOME, "send-input-pending");
  const deliveredFile = join(HOME, "send-input-delivered.bin");
  writeFileSync(pendingFile, "");
  writeFileSync(deliveredFile, "");
  // The delivery protocol itself is covered by core/service/herdr-prompt.test.ts; this fake only
  // has to make the pane's pending/delivered state visible so the RPC's own error mapping — which
  // phase failed, and what the operator is told about the pane — can be asserted.
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$3" = "agent" ]; then printf '%s' '${agents}'; exit 0; fi`,
      `if [ "$4" = "send-text" ]; then`,
      `  if [ "$LH_TEST_SEND_INPUT_FAIL" = "text" ]; then exit 3; fi`,
      `  printf '%s' "$6" > ${pendingFile}; exit 0`,
      "fi",
      `if [ "$4" = "send-keys" ] && [ "$6" = "Enter" ]; then`,
      `  if [ "$LH_TEST_SEND_INPUT_FAIL" = "submit" ]; then exit 7; fi`,
      `  cat ${pendingFile} >> ${deliveredFile}; printf '\\0' >> ${deliveredFile}; : > ${pendingFile}`,
      "fi",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  const send = (text: string) =>
    svc.terminal.sendAgentInput({
      repo: repo.full_name,
      pull: prRow.number,
      paneId,
      text,
    });
  try {
    await expect(send("続けて")).resolves.toEqual({ ok: true });
    expect(readFileSync(pendingFile, "utf8")).toBe("");
    expect(readFileSync(deliveredFile).toString()).toBe(
      "\u001b[200~続けて\u001b[201~\0",
    );

    process.env.LH_TEST_SEND_INPUT_FAIL = "text";
    await expect(send("再送")).rejects.toThrowError(
      "The Herdr agent disappeared before the input could be sent",
    );
    expect(readFileSync(pendingFile, "utf8")).toBe("");

    process.env.LH_TEST_SEND_INPUT_FAIL = "submit";
    await expect(send("再送")).rejects.toThrowError(
      "The input was written, but Herdr could not submit it; check the pane before retrying",
    );
    expect(readFileSync(pendingFile, "utf8")).toBe(
      "\u001b[200~再送\u001b[201~",
    );
    expect(readFileSync(deliveredFile).toString()).toBe(
      "\u001b[200~続けて\u001b[201~\0",
    );
  } finally {
    delete process.env.LH_TEST_SEND_INPUT_FAIL;
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
