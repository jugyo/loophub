import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-herdr-sessions-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
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
  ({ herdrSessionName } = await import("./terminal-launch.ts"));
  ({ worktreeRoot } = await import("./config.ts"));
  ({ worktreePath } = await import("./worktree-path.ts"));
  mkdirSync(FAKE_BIN);
  mkdirSync(EMPTY_BIN);
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(HOME, { recursive: true, force: true });
});

test("terminal.sessions groups running herdr agents by repo and drops agentless sessions", async () => {
  const withAgents = await svc.repos.create({
    path: initGitRepo(),
    name: "me/with-agents",
  });
  const agentless = await svc.repos.create({
    path: initGitRepo(),
    name: "me/agentless",
  });
  await svc.repos.create({ path: initGitRepo(), name: "me/not-running" });

  const sessionA = herdrSessionName(withAgents);
  const sessionB = herdrSessionName(agentless);

  // Fake herdr replaying real CLI shapes: `herdr session list --json` prints the session
  // list; `herdr --session <name> agent list` ($2 = name) prints that session's agents.
  const sessionList = JSON.stringify({
    sessions: [
      { default: true, name: "default", running: true },
      { default: false, name: sessionA, running: true },
      { default: false, name: sessionB, running: true },
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
      `printf '%s' '${empty}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    const result = await svc.terminal.sessions();
    // me/agentless runs a session with zero agents and me/not-running has no session —
    // neither produces a group.
    expect(result.repos).toEqual([
      {
        repo: "me/with-agents",
        session_name: sessionA,
        agents: [
          { id: "w1:p2", name: "dev #11", status: "working" },
          { id: "w1:pC", name: "dev #13", status: "blocked" },
        ],
        pull_workspaces: [],
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
        agents: [{ id: "wP:p2", name: "Issue #9 - PR 12", status: "working" }],
        pull_workspaces: [{ pull: 12, pane_id: "wP:p2", status: "working" }],
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

// #521: sidebar kill button. killAgent runs `herdr --session <name> pane close <paneId>` for
// the repo's deterministic session and surfaces failures instead of degrading like sessions().
test("terminal.killAgent runs herdr pane close scoped to the repo's session", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/kill-target",
  });
  const sessionName = herdrSessionName(repo);
  const CALLS_FILE = join(HOME, "kill-calls.txt");
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    ["#!/bin/sh", `echo "$@" >> ${CALLS_FILE}`, "exit 0"].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
  try {
    await expect(
      svc.terminal.killAgent({ repo: "me/kill-target", paneId: "w1:p2" }),
    ).resolves.toEqual({ ok: true });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(CALLS_FILE, "utf8").trim()).toBe(
      `--session ${sessionName} pane close w1:p2`,
    );
  } finally {
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
