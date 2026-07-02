import { describe, expect, test } from "vitest";
import {
  parseHerdrAgentList,
  parseHerdrAgentRead,
  parseHerdrSessionList,
  reposWithRunningSession,
} from "./herdr-status.ts";
import { herdrSessionName } from "./terminal-launch.ts";

// Real-shaped fixture from `herdr session list --json`.
const SESSION_LIST = JSON.stringify({
  sessions: [
    {
      default: true,
      name: "default",
      running: true,
      session_dir: "/home/u/.config/herdr",
      socket_path: "/home/u/.config/herdr/herdr.sock",
    },
    {
      default: false,
      name: "me-app-12345678",
      running: true,
      session_dir: "/home/u/.config/herdr/sessions/me-app-12345678",
      socket_path: "/home/u/.config/herdr/sessions/me-app-12345678/herdr.sock",
    },
    { default: false, name: "stopped-one", running: false },
  ],
});

// Real-shaped fixture from `herdr --session <name> agent list` (JSON without any flag).
const AGENT_LIST = JSON.stringify({
  id: "cli:agent:list",
  result: {
    agents: [
      {
        agent: "claude",
        agent_status: "working",
        cwd: "/home/u/ws/app",
        foreground_cwd: "/home/u/.loophub/worktrees/me/app/pr-12",
        name: "dev #11",
        pane_id: "w1:p2",
      },
      {
        agent: "claude",
        agent_status: "blocked",
        name: "dev #13",
      },
    ],
    type: "agent_list",
  },
});

describe("parseHerdrSessionList", () => {
  test("returns names of running sessions only", () => {
    expect(parseHerdrSessionList(SESSION_LIST)).toEqual([
      "default",
      "me-app-12345678",
    ]);
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing sessions key"],
    ['{"sessions": "nope"}', "sessions not an array"],
    ['{"sessions": [{"running": true}, 42]}', "malformed entries"],
  ])("degrades to [] on %s (%s)", (input) => {
    expect(parseHerdrSessionList(input)).toEqual([]);
  });
});

describe("parseHerdrAgentList", () => {
  test("maps id (pane_id), name, and agent_status", () => {
    expect(parseHerdrAgentList(AGENT_LIST)).toEqual([
      { id: "w1:p2", name: "dev #11", status: "working" },
      { id: "\u0000idx:1", name: "dev #13", status: "blocked" },
    ]);
  });

  test("id stays unique when pane_id is missing and names collide", () => {
    const out = parseHerdrAgentList(
      JSON.stringify({
        result: {
          agents: [
            { name: "dev #1", agent_status: "working" },
            { name: "dev #1", agent_status: "idle" },
          ],
        },
      }),
    );
    expect(out.map((a) => a.id)).toEqual(["\u0000idx:0", "\u0000idx:1"]);
  });

  test("skips entries without a name; status falls back to empty string", () => {
    const out = parseHerdrAgentList(
      JSON.stringify({
        result: {
          agents: [
            { agent_status: "working" },
            { name: "" },
            { name: "unnamed-status" },
            null,
          ],
        },
      }),
    );
    expect(out).toEqual([
      { id: "\u0000idx:0", name: "unnamed-status", status: "" },
    ]);
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing agents"],
  ])("degrades to [] on %s (%s)", (input) => {
    expect(parseHerdrAgentList(input)).toEqual([]);
  });
});

describe("parseHerdrAgentRead", () => {
  // Real-shaped fixture from `herdr --session <name> agent read <target>`.
  const AGENT_READ = JSON.stringify({
    id: "cli:agent:read",
    result: {
      read: {
        format: "text",
        pane_id: "w1:pR",
        revision: 0,
        source: "recent",
        tab_id: "w1:t9",
        text: "$ npm test\n42 passing\n",
        truncated: false,
        workspace_id: "w1",
      },
    },
    type: "pane_read",
  });

  test("extracts result.read.text", () => {
    expect(parseHerdrAgentRead(AGENT_READ)).toBe("$ npm test\n42 passing\n");
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing read"],
    ['{"result": {"read": {}}}', "missing text"],
    [
      '{"error":{"code":"agent_not_found","message":"agent target x not found"}}',
      "error response",
    ],
  ])("degrades to null on %s (%s)", (input) => {
    expect(parseHerdrAgentRead(input)).toBeNull();
  });
});

describe("reposWithRunningSession", () => {
  test("matches repos whose deterministic session name is running", () => {
    const a = { full_name: "me/app", local_path: "/w/app" };
    const b = { full_name: "me/other", local_path: "/w/other" };
    const running = [herdrSessionName(a), "default"];
    expect(reposWithRunningSession([a, b], running)).toEqual([
      { repo: a, sessionName: herdrSessionName(a) },
    ]);
  });

  test("empty when nothing is running", () => {
    const a = { full_name: "me/app", local_path: "/w/app" };
    expect(reposWithRunningSession([a], [])).toEqual([]);
  });
});
