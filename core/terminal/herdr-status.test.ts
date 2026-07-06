import { describe, expect, test } from "vitest";
import {
  herdrIssueWorkspacesFromAgentList,
  herdrPullWorkspacesFromAgentList,
  paneRunsClaudeResume,
  parseHerdrAgentList,
  parseHerdrAgentPlacements,
  parseHerdrAgentRead,
  parseHerdrPaneKillTarget,
  parseHerdrPaneLayout,
  parseHerdrPaneProcessInfo,
  parseHerdrSessionList,
  parseHerdrTabList,
  parseHerdrWorkspaceList,
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

describe("herdrPullWorkspacesFromAgentList", () => {
  const ROOT = "/home/u/.loophub/worktrees";
  const FULL_NAME = "me/app";

  // Real-shaped fixture from `herdr --session <name> agent list`: one agent running in the
  // PR-12 worktree (via foreground_cwd), one whose only cwd is the repo root (not a PR
  // worktree), and one on the legacy issue-<n> convention (not resolved, #579 out of scope).
  const AGENT_LIST_WITH_WORKSPACES = JSON.stringify({
    result: {
      agents: [
        {
          name: "Issue #9 - PR 12",
          agent_status: "working",
          pane_id: "wP:p2",
          tab_id: "wP:t1",
          workspace_id: "wP",
          cwd: "/home/u/ws/app",
          foreground_cwd: `${ROOT}/${FULL_NAME}/pr-12`,
        },
        {
          name: "New issue",
          agent_status: "working",
          pane_id: "wQ:p2",
          tab_id: "wQ:t1",
          workspace_id: "wQ",
          cwd: "/home/u/ws/app",
        },
        {
          name: "legacy dev",
          agent_status: "working",
          pane_id: "wR:p2",
          tab_id: "wR:t1",
          workspace_id: "wR",
          foreground_cwd: `${ROOT}/${FULL_NAME}/issue-9`,
        },
      ],
    },
  });

  test("maps an agent's foreground_cwd back to its PR number", () => {
    expect(
      herdrPullWorkspacesFromAgentList(
        AGENT_LIST_WITH_WORKSPACES,
        ROOT,
        FULL_NAME,
      ),
    ).toEqual([{ pull: 12, pane_id: "wP:p2", status: "working" }]);
  });

  test("falls back to cwd when foreground_cwd is absent", () => {
    const out = herdrPullWorkspacesFromAgentList(
      JSON.stringify({
        result: {
          agents: [
            {
              pane_id: "wP:p2",
              cwd: `${ROOT}/${FULL_NAME}/pr-12`,
              agent_status: "idle",
            },
          ],
        },
      }),
      ROOT,
      FULL_NAME,
    );
    expect(out).toEqual([{ pull: 12, pane_id: "wP:p2", status: "idle" }]);
  });

  test("skips an agent with no pane_id", () => {
    const out = herdrPullWorkspacesFromAgentList(
      JSON.stringify({
        result: {
          agents: [{ cwd: `${ROOT}/${FULL_NAME}/pr-12` }],
        },
      }),
      ROOT,
      FULL_NAME,
    );
    expect(out).toEqual([]);
  });

  test("keeps only the first agent when two share one PR's worktree", () => {
    const out = herdrPullWorkspacesFromAgentList(
      JSON.stringify({
        result: {
          agents: [
            {
              pane_id: "wP:p2",
              cwd: `${ROOT}/${FULL_NAME}/pr-12`,
              agent_status: "working",
            },
            {
              pane_id: "wP:p9",
              cwd: `${ROOT}/${FULL_NAME}/pr-12`,
              agent_status: "done",
            },
          ],
        },
      }),
      ROOT,
      FULL_NAME,
    );
    expect(out).toEqual([{ pull: 12, pane_id: "wP:p2", status: "working" }]);
  });

  test("defaults status to empty string when agent_status is missing or not a string", () => {
    const out = herdrPullWorkspacesFromAgentList(
      JSON.stringify({
        result: {
          agents: [
            {
              pane_id: "wP:p2",
              cwd: `${ROOT}/${FULL_NAME}/pr-12`,
              agent_status: 42,
            },
          ],
        },
      }),
      ROOT,
      FULL_NAME,
    );
    expect(out).toEqual([{ pull: 12, pane_id: "wP:p2", status: "" }]);
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing agents"],
  ])("degrades to [] on %s (%s)", (input) => {
    expect(herdrPullWorkspacesFromAgentList(input, ROOT, FULL_NAME)).toEqual(
      [],
    );
  });
});

describe("herdrIssueWorkspacesFromAgentList", () => {
  const ROOT = "/home/u/.loophub/worktrees";
  const FULL_NAME = "me/app";

  // One agent in the pr-12 worktree, one in pr-20 (whose PR the caller's map doesn't know), one
  // at the repo root (no PR worktree — the New Issue flow).
  const AGENT_LIST = JSON.stringify({
    result: {
      agents: [
        {
          name: "PR 12",
          agent_status: "working",
          pane_id: "wP:p2",
          foreground_cwd: `${ROOT}/${FULL_NAME}/pr-12`,
        },
        {
          name: "PR 20",
          agent_status: "idle",
          pane_id: "wT:p2",
          foreground_cwd: `${ROOT}/${FULL_NAME}/pr-20`,
        },
        {
          name: "New issue",
          agent_status: "working",
          pane_id: "wQ:p2",
          cwd: "/home/u/ws/app",
        },
      ],
    },
  });

  test("maps an agent's PR worktree to the issue its PR closes", () => {
    // Only pr-12 is in the map; pr-20's agent and the repo-root agent are dropped.
    expect(
      herdrIssueWorkspacesFromAgentList(
        AGENT_LIST,
        ROOT,
        FULL_NAME,
        new Map([[12, 9]]),
      ),
    ).toEqual([{ issue: 9, pane_id: "wP:p2", status: "working" }]);
  });

  test("keeps only the first agent when two PRs close the same issue", () => {
    const out = herdrIssueWorkspacesFromAgentList(
      JSON.stringify({
        result: {
          agents: [
            {
              pane_id: "wP:p2",
              cwd: `${ROOT}/${FULL_NAME}/pr-12`,
              agent_status: "working",
            },
            {
              pane_id: "wS:p2",
              cwd: `${ROOT}/${FULL_NAME}/pr-15`,
              agent_status: "done",
            },
          ],
        },
      }),
      ROOT,
      FULL_NAME,
      new Map([
        [12, 9],
        [15, 9],
      ]),
    );
    expect(out).toEqual([{ issue: 9, pane_id: "wP:p2", status: "working" }]);
  });

  test("returns [] when no agent's PR is in the map", () => {
    expect(
      herdrIssueWorkspacesFromAgentList(AGENT_LIST, ROOT, FULL_NAME, new Map()),
    ).toEqual([]);
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ['{"result": {}}', "missing agents"],
  ])("degrades to [] on %s (%s)", (input) => {
    expect(
      herdrIssueWorkspacesFromAgentList(
        input,
        ROOT,
        FULL_NAME,
        new Map([[12, 9]]),
      ),
    ).toEqual([]);
  });
});

describe("parseHerdrWorkspaceList", () => {
  // Real-shaped fixture from `herdr --session <name> workspace list`.
  const WORKSPACE_LIST = JSON.stringify({
    id: "cli:workspace:list",
    result: {
      type: "workspace_list",
      workspaces: [
        {
          workspace_id: "wY",
          label: "pr-597",
          number: 1,
          agent_status: "working",
          focused: false,
          pane_count: 1,
          tab_count: 1,
          active_tab_id: "wY:t1",
        },
        { workspace_id: "w13", label: "loophub", number: 4 },
      ],
    },
  });

  test("extracts id (workspace_id), label, and number", () => {
    expect(parseHerdrWorkspaceList(WORKSPACE_LIST)).toEqual([
      { id: "wY", label: "pr-597", number: 1 },
      { id: "w13", label: "loophub", number: 4 },
    ]);
  });

  test("falls back to workspace_id for a missing label, and 0 for a missing number", () => {
    const out = parseHerdrWorkspaceList(
      JSON.stringify({ result: { workspaces: [{ workspace_id: "w1" }] } }),
    );
    expect(out).toEqual([{ id: "w1", label: "w1", number: 0 }]);
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing workspaces"],
    ['{"result": {"workspaces": [{}, 42]}}', "malformed entries"],
  ])("degrades to [] on %s (%s)", (input) => {
    expect(parseHerdrWorkspaceList(input)).toEqual([]);
  });
});

describe("parseHerdrTabList", () => {
  // Real-shaped fixture from `herdr --session <name> tab list`.
  const TAB_LIST = JSON.stringify({
    id: "cli:tab:list",
    result: {
      type: "tab_list",
      tabs: [
        {
          tab_id: "w12:t1",
          workspace_id: "w12",
          label: "1",
          number: 1,
          agent_status: "working",
          focused: false,
          pane_count: 1,
        },
      ],
    },
  });

  test("extracts id (tab_id), workspaceId, and number", () => {
    expect(parseHerdrTabList(TAB_LIST)).toEqual([
      { id: "w12:t1", workspaceId: "w12", number: 1 },
    ]);
  });

  test("skips a tab missing tab_id or workspace_id", () => {
    const out = parseHerdrTabList(
      JSON.stringify({
        result: {
          tabs: [{ workspace_id: "w1" }, { tab_id: "w1:t1" }],
        },
      }),
    );
    expect(out).toEqual([]);
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing tabs"],
  ])("degrades to [] on %s (%s)", (input) => {
    expect(parseHerdrTabList(input)).toEqual([]);
  });
});

describe("parseHerdrAgentPlacements", () => {
  const ROOT = "/home/u/.loophub/worktrees";
  const FULL_NAME = "me/app";

  test("resolves workspace/tab ids and the PR the agent's cwd belongs to", () => {
    const out = parseHerdrAgentPlacements(
      JSON.stringify({
        result: {
          agents: [
            {
              name: "dev #11",
              agent_status: "working",
              pane_id: "w1:p2",
              tab_id: "w1:t1",
              workspace_id: "w1",
              foreground_cwd: `${ROOT}/${FULL_NAME}/pr-12`,
            },
          ],
        },
      }),
      ROOT,
      FULL_NAME,
    );
    expect(out).toEqual([
      {
        id: "w1:p2",
        name: "dev #11",
        status: "working",
        workspaceId: "w1",
        tabId: "w1:t1",
        pull: 12,
      },
    ]);
  });

  test("pull is null when the agent's cwd doesn't resolve to a PR worktree", () => {
    const out = parseHerdrAgentPlacements(
      JSON.stringify({
        result: {
          agents: [
            {
              name: "New issue",
              agent_status: "idle",
              pane_id: "w2:p2",
              tab_id: "w2:t1",
              workspace_id: "w2",
              cwd: "/home/u/ws/app",
            },
          ],
        },
      }),
      ROOT,
      FULL_NAME,
    );
    expect(out).toEqual([
      {
        id: "w2:p2",
        name: "New issue",
        status: "idle",
        workspaceId: "w2",
        tabId: "w2:t1",
        pull: null,
      },
    ]);
  });

  test("workspaceId/tabId are null when herdr omits them, id falls back like parseHerdrAgentList", () => {
    const out = parseHerdrAgentPlacements(
      JSON.stringify({ result: { agents: [{ name: "no-ids" }] } }),
      ROOT,
      FULL_NAME,
    );
    expect(out).toEqual([
      {
        id: "\u0000idx:0",
        name: "no-ids",
        status: "",
        workspaceId: null,
        tabId: null,
        pull: null,
      },
    ]);
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing agents"],
  ])("degrades to [] on %s (%s)", (input) => {
    expect(parseHerdrAgentPlacements(input, ROOT, FULL_NAME)).toEqual([]);
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

  test("keeps SGR color codes but strips OSC title sequences (#523, #554)", () => {
    const withAnsi = JSON.stringify({
      result: {
        read: {
          text: "\x1b]0;my-title\x07\x1b[32mPASS\x1b[0m \x1b[1mnpm test\x1b[0m\n",
        },
      },
    });
    expect(parseHerdrAgentRead(withAnsi)).toBe(
      "\x1b[32mPASS\x1b[0m \x1b[1mnpm test\x1b[0m\n",
    );
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

  test("keeps colon-delimited (ITU-T direct-color) SGR sequences (#523 round 2, #554)", () => {
    const withColonSgr = JSON.stringify({
      result: { read: { text: "\x1b[38:2:255:0:0mRED\x1b[0m\n" } },
    });
    expect(parseHerdrAgentRead(withColonSgr)).toBe(
      "\x1b[38:2:255:0:0mRED\x1b[0m\n",
    );
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

  test("drops a truncated CSI introducer with no final byte instead of leaking its params, but keeps the SGR that follows it (#523 round 2, #554)", () => {
    const withTruncatedCsi = JSON.stringify({
      result: { read: { text: "\x1b[1\x1b[mHELLO" } },
    });
    expect(parseHerdrAgentRead(withTruncatedCsi)).toBe("\x1b[mHELLO");
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

describe("parseHerdrPaneLayout", () => {
  // Real-shaped fixture from `herdr --session <name> pane layout --pane <pane_id>`.
  const PANE_LAYOUT = JSON.stringify({
    result: { layout: { area: { height: 85, width: 239, x: 36, y: 1 } } },
  });

  test("extracts result.layout.area.width/height as cols/rows", () => {
    expect(parseHerdrPaneLayout(PANE_LAYOUT)).toEqual({ cols: 239, rows: 85 });
  });

  test("rounds non-integer dimensions", () => {
    const withFloats = JSON.stringify({
      result: { layout: { area: { width: 80.4, height: 24.6 } } },
    });
    expect(parseHerdrPaneLayout(withFloats)).toEqual({ cols: 80, rows: 25 });
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing layout"],
    ['{"result": {"layout": {}}}', "missing area"],
    ['{"result": {"layout": {"area": {"width": 80}}}}', "missing height"],
    [
      '{"result": {"layout": {"area": {"width": 0, "height": 24}}}}',
      "non-positive width",
    ],
    [
      '{"result": {"layout": {"area": {"width": 80, "height": -1}}}}',
      "negative height",
    ],
    [
      '{"error":{"code":"pane_not_found","message":"pane target x not found"}}',
      "error response",
    ],
  ])("degrades to null on %s (%s)", (input) => {
    expect(parseHerdrPaneLayout(input)).toBeNull();
  });
});

describe("parseHerdrPaneProcessInfo", () => {
  // Real-shaped fixture from `herdr --session <name> pane process-info --pane <pane_id>`.
  const PROCESS_INFO = JSON.stringify({
    result: {
      process_info: {
        foreground_process_group_id: 32732,
        foreground_processes: [
          {
            argv: ["node", "/path/to/some-mcp-server"],
            cwd: "/w/app",
            name: "node",
            pid: 33197,
          },
          // Some processes are reported name-only, with no argv (e.g. herdr couldn't resolve
          // the full command line) — these must be dropped, not crash the parse.
          { argv0: "mcp@0.0.76", cwd: "/w/app", name: "node", pid: 32778 },
          {
            argv: [
              "claude",
              "--resume",
              "416a33e4-903e-44c9-b0f8-591c65f8b395",
            ],
            cwd: "/w/app",
            name: "claude",
            pid: 32732,
          },
        ],
        pane_id: "wF:p9",
        shell_pid: 32732,
      },
    },
    type: "pane_process_info",
  });

  test("extracts each foreground process's argv, dropping entries without one", () => {
    expect(parseHerdrPaneProcessInfo(PROCESS_INFO)).toEqual([
      ["node", "/path/to/some-mcp-server"],
      ["claude", "--resume", "416a33e4-903e-44c9-b0f8-591c65f8b395"],
    ]);
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing process_info"],
    ['{"result": {"process_info": {}}}', "missing foreground_processes"],
    [
      '{"error":{"code":"pane_not_found","message":"pane target x not found"}}',
      "error response",
    ],
  ])("degrades to null on %s (%s)", (input) => {
    expect(parseHerdrPaneProcessInfo(input)).toBeNull();
  });
});

describe("parseHerdrPaneKillTarget", () => {
  test("prefers foreground_process_group_id over shell_pid", () => {
    expect(
      parseHerdrPaneKillTarget(
        JSON.stringify({
          result: {
            process_info: {
              foreground_process_group_id: 32732,
              shell_pid: 11616,
            },
          },
        }),
      ),
    ).toBe(32732);
  });

  test("falls back to shell_pid when the group id is missing", () => {
    expect(
      parseHerdrPaneKillTarget(
        JSON.stringify({
          result: { process_info: { shell_pid: 11616 } },
        }),
      ),
    ).toBe(11616);
  });

  // #805 review: the caller negates this into a POSIX process-group signal
  // (`process.kill(-pid, ...)`), and `kill(-1, ...)` is the documented special case for
  // "signal every process the caller has permission to signal" — a system-wide broadcast,
  // not "process group 1". A pid of 1 must never be returned as a kill target.
  test.each([
    [
      "foreground_process_group_id",
      JSON.stringify({
        result: { process_info: { foreground_process_group_id: 1 } },
      }),
    ],
    [
      "shell_pid",
      JSON.stringify({ result: { process_info: { shell_pid: 1 } } }),
    ],
  ])("rejects a pid of 1 (%s)", (_field, input) => {
    expect(parseHerdrPaneKillTarget(input)).toBeNull();
  });

  test.each([
    ["", "empty"],
    ["not json", "non-JSON"],
    ["{}", "missing result"],
    ['{"result": {}}', "missing process_info"],
    [
      '{"result": {"process_info": {"foreground_process_group_id": 0}}}',
      "zero pid",
    ],
    [
      '{"result": {"process_info": {"foreground_process_group_id": -5}}}',
      "negative pid",
    ],
    [
      '{"result": {"process_info": {"foreground_process_group_id": "32732"}}}',
      "non-numeric pid",
    ],
  ])("degrades to null on %s (%s)", (input) => {
    expect(parseHerdrPaneKillTarget(input)).toBeNull();
  });
});

describe("paneRunsClaudeResume", () => {
  const SESSION = "416a33e4-903e-44c9-b0f8-591c65f8b395";

  test("true when a foreground process is exactly claude --resume <session>", () => {
    expect(
      paneRunsClaudeResume(
        [
          ["node", "/path/to/some-mcp-server"],
          ["claude", "--resume", SESSION],
        ],
        SESSION,
      ),
    ).toBe(true);
  });

  test("false for a different session id (no false positive across sessions, #578)", () => {
    expect(
      paneRunsClaudeResume([["claude", "--resume", "other-session"]], SESSION),
    ).toBe(false);
  });

  test("false when extra flags surround the resume args (exact match only, #578 review)", () => {
    expect(
      paneRunsClaudeResume(
        [["claude", "--resume", SESSION, "--continue"]],
        SESSION,
      ),
    ).toBe(false);
    expect(
      paneRunsClaudeResume(
        [["claude", "--model", "x", "--resume", SESSION]],
        SESSION,
      ),
    ).toBe(false);
  });

  test("false when nothing in the pane is claude at all", () => {
    expect(
      paneRunsClaudeResume(
        [["node", "server.js", "--resume", SESSION]],
        SESSION,
      ),
    ).toBe(false);
  });

  test("false for a bare claude launch with no --resume", () => {
    expect(paneRunsClaudeResume([["claude"]], SESSION)).toBe(false);
  });

  test("false on an empty process list", () => {
    expect(paneRunsClaudeResume([], SESSION)).toBe(false);
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
