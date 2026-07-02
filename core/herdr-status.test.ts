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

  test("strips SGR color codes and OSC title sequences (#523)", () => {
    const withAnsi = JSON.stringify({
      result: {
        read: {
          text: "\x1b]0;my-title\x07\x1b[32mPASS\x1b[0m \x1b[1mnpm test\x1b[0m\n",
        },
      },
    });
    expect(parseHerdrAgentRead(withAnsi)).toBe("PASS npm test\n");
  });

  test("keeps text between two ST-terminated OSC sequences instead of swallowing it (#523 round 2)", () => {
    const withHyperlink = JSON.stringify({
      result: {
        read: {
          text: "before \x1b]8;;http://example.com\x1b\\link text\x1b]8;;\x1b\\ after\n",
        },
      },
    });
    expect(parseHerdrAgentRead(withHyperlink)).toBe("before link text after\n");
  });

  test("strips colon-delimited (ITU-T direct-color) SGR sequences (#523 round 2)", () => {
    const withColonSgr = JSON.stringify({
      result: { read: { text: "\x1b[38:2:255:0:0mRED\x1b[0m\n" } },
    });
    expect(parseHerdrAgentRead(withColonSgr)).toBe("RED\n");
  });

  test("strips save/restore-cursor escape sequences (#523 round 2)", () => {
    const withCursorSave = JSON.stringify({
      result: { read: { text: "\x1b7saved\x1b8\n" } },
    });
    expect(parseHerdrAgentRead(withCursorSave)).toBe("saved\n");
  });

  test("doesn't swallow real text after a malformed CSI whose parameters run into ordinary prose (#523 round 3)", () => {
    const withMalformedCsi = JSON.stringify({
      result: { read: { text: "\x1b[123 processes running\n" } },
    });
    expect(parseHerdrAgentRead(withMalformedCsi)).toBe(" processes running\n");
  });

  test("doesn't swallow real text after a malformed colon-param CSI (#523 round 3)", () => {
    const withMalformedCsi = JSON.stringify({
      result: { read: { text: "\x1b[38:2 red badge\n" } },
    });
    expect(parseHerdrAgentRead(withMalformedCsi)).toBe(" red badge\n");
  });

  test("strips a run of unterminated OSC sequences without pathological slowdown (#523 round 2)", () => {
    const withRunawayOsc = JSON.stringify({
      result: { read: { text: `${"\x1b]".repeat(65536)}done\n` } },
    });
    const start = Date.now();
    const result = parseHerdrAgentRead(withRunawayOsc);
    expect(Date.now() - start).toBeLessThan(500);
    expect(result?.endsWith("done\n")).toBe(true);
  });

  test("drops a truncated CSI introducer with no final byte instead of leaking its params (#523 round 2)", () => {
    const withTruncatedCsi = JSON.stringify({
      result: { read: { text: "\x1b[1\x1b[mHELLO" } },
    });
    expect(parseHerdrAgentRead(withTruncatedCsi)).toBe("HELLO");
  });

  test("normalizes CRLF to LF and drops stray progress-bar carriage returns (#523)", () => {
    const withCr = JSON.stringify({
      result: {
        read: { text: "line one\r\nprogress: 50%\rprogress: 100%\r\ndone\n" },
      },
    });
    expect(parseHerdrAgentRead(withCr)).toBe(
      "line one\nprogress: 50%progress: 100%\ndone\n",
    );
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
