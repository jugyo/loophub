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
