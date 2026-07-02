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
