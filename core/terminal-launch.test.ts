import { describe, expect, test } from "vitest";
import {
  buildHerdrLaunchPlan,
  commandForHerdrLaunch,
  herdrPaneCloseArgv,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceCreateArgv,
  normalizeTerminalLaunchBackend,
  parseHerdrRootPaneId,
  parseHerdrTabId,
  parseHerdrWorkspaceId,
} from "./terminal-launch.ts";

describe("terminal launch backend", () => {
  test("normalizes unknown values to builtin", () => {
    expect(normalizeTerminalLaunchBackend("herdr")).toBe("herdr");
    expect(normalizeTerminalLaunchBackend("builtin")).toBe("builtin");
    expect(normalizeTerminalLaunchBackend("tmux")).toBe("builtin");
    expect(normalizeTerminalLaunchBackend(undefined)).toBe("builtin");
  });

  test("builds deterministic path-safe Herdr session names from repo and path", () => {
    const a = herdrSessionName({
      full_name: "loophub/loophub",
      local_path: "/repo/a",
    });
    const b = herdrSessionName({
      full_name: "loophub/loophub",
      local_path: "/repo/b",
    });
    expect(a).toMatch(/^loophub-loophub-[a-f0-9]{8}$/);
    expect(a).not.toBe(b);
    expect(a).toBe(
      herdrSessionName({
        full_name: "loophub/loophub",
        local_path: "/repo/a",
      }),
    );
  });

  test("normalizes issue workflows for Herdr", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-dev",
        issueNumber: 444,
      }),
    ).toBe("lh dev 'jugyo/loophub/444'");
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-create",
      }),
    ).toBe("lh issue new --repo 'jugyo/loophub'");
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
      }),
    ).toBe("claude '/create-github-pr 451'");
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "resume",
        session: "session-1",
        cwd: "/tmp/work tree",
      }),
    ).toBe("cd '/tmp/work tree' && claude --resume 'session-1'");
  });

  test("appends --auto to the issue-dev command when auto is set (#499)", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-dev",
        issueNumber: 444,
        auto: true,
      }),
    ).toBe("lh dev 'jugyo/loophub/444' --auto");
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-dev",
        issueNumber: 444,
        auto: false,
      }),
    ).toBe("lh dev 'jugyo/loophub/444'");
  });

  test("shell-quotes repo names in generated workflows", () => {
    expect(
      commandForHerdrLaunch({
        repo: "bad/re'po; touch nope",
        workflow: "issue-create",
      }),
    ).toBe("lh issue new --repo 'bad/re'\\''po; touch nope'");
  });

  test("builds Herdr agent start argv without shell interpolation", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh dev 'jugyo/loophub/444'",
      label: "dev #444",
      tabId: "w1:t2",
    });
    expect(plan.argv).toEqual([
      "herdr",
      "--session",
      plan.sessionName,
      "agent",
      "start",
      "dev #444",
      "--cwd",
      "/repo/main",
      "--tab",
      "w1:t2",
      "--no-focus",
      "--",
      "zsh",
      "-lc",
      "lh dev 'jugyo/loophub/444'",
    ]);
  });

  test("omits --tab when tab creation did not yield an id (fallback to split)", () => {
    for (const tabId of [undefined, null]) {
      const plan = buildHerdrLaunchPlan({
        repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
        command: "lh dev 'jugyo/loophub/444'",
        label: "dev #444",
        tabId,
      });
      expect(plan.argv).not.toContain("--tab");
    }
  });

  test("builds Herdr tab create/close argv scoped to the repo session", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const sessionName = herdrSessionName(repo);
    expect(herdrTabCreateArgv(repo)).toEqual([
      "herdr",
      "--session",
      sessionName,
      "tab",
      "create",
      "--cwd",
      "/repo/main",
      "--no-focus",
    ]);
    expect(herdrTabCloseArgv(repo, "w1:t2")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "tab",
      "close",
      "w1:t2",
    ]);
    expect(herdrPaneCloseArgv(repo, "w1:p1Q")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "pane",
      "close",
      "w1:p1Q",
    ]);
  });

  test("builds Herdr workspace create/close argv scoped to the repo session (#544)", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const sessionName = herdrSessionName(repo);
    expect(herdrWorkspaceCreateArgv(repo)).toEqual([
      "herdr",
      "--session",
      sessionName,
      "workspace",
      "create",
      "--cwd",
      "/repo/main",
      "--no-focus",
    ]);
    expect(herdrWorkspaceCloseArgv(repo, "w4")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "workspace",
      "close",
      "w4",
    ]);
  });

  test("builds Herdr pane close argv scoped to the repo session (#521)", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const sessionName = herdrSessionName(repo);
    expect(herdrPaneCloseArgv(repo, "w1:p2")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "pane",
      "close",
      "w1:p2",
    ]);
  });

  test("parses the tab id from herdr tab create output", () => {
    expect(
      parseHerdrTabId(
        '{"id":"cli:tab:create","result":{"tab":{"tab_id":"w1:t2","workspace_id":"w1"},"type":"tab_created"}}',
      ),
    ).toBe("w1:t2");
    expect(parseHerdrTabId("")).toBeNull();
    expect(parseHerdrTabId("not json")).toBeNull();
    expect(parseHerdrTabId('{"result":{"tab":{}}}')).toBeNull();
    expect(parseHerdrTabId('{"result":{"tab":{"tab_id":42}}}')).toBeNull();
  });

  test("rejects tab ids that could be parsed as flags or shell noise", () => {
    const wrap = (id: string) =>
      JSON.stringify({ result: { tab: { tab_id: id } } });
    expect(parseHerdrTabId(wrap("--workspace"))).toBeNull();
    expect(parseHerdrTabId(wrap("-x"))).toBeNull();
    expect(parseHerdrTabId(wrap("w1 t2"))).toBeNull();
    expect(parseHerdrTabId(wrap("w1;rm"))).toBeNull();
    expect(parseHerdrTabId(wrap(""))).toBeNull();
    expect(parseHerdrTabId(wrap("w1:t2"))).toBe("w1:t2");
  });

  // `herdr tab create` seeds the new tab with one empty default pane (`root_pane`); the caller
  // must close it after the agent's own pane starts, or it's left behind as a split (#503).
  test("parses the root pane id from herdr tab create output", () => {
    expect(
      parseHerdrRootPaneId(
        '{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"w1:p1Q"},"tab":{"tab_id":"w1:t2"},"type":"tab_created"}}',
      ),
    ).toBe("w1:p1Q");
    expect(parseHerdrRootPaneId("")).toBeNull();
    expect(parseHerdrRootPaneId("not json")).toBeNull();
    expect(parseHerdrRootPaneId('{"result":{"root_pane":{}}}')).toBeNull();
    expect(
      parseHerdrRootPaneId('{"result":{"root_pane":{"pane_id":42}}}'),
    ).toBeNull();
    expect(
      parseHerdrRootPaneId(
        JSON.stringify({ result: { root_pane: { pane_id: "--workspace" } } }),
      ),
    ).toBeNull();
  });

  test("parses the workspace id from herdr workspace create output", () => {
    expect(
      parseHerdrWorkspaceId(
        '{"id":"cli:workspace:create","result":{"root_pane":{"pane_id":"w4:p1"},"tab":{"tab_id":"w4:t1"},"type":"workspace_created","workspace":{"workspace_id":"w4"}}}',
      ),
    ).toBe("w4");
    expect(parseHerdrWorkspaceId("")).toBeNull();
    expect(parseHerdrWorkspaceId("not json")).toBeNull();
    expect(parseHerdrWorkspaceId('{"result":{"workspace":{}}}')).toBeNull();
    expect(
      parseHerdrWorkspaceId('{"result":{"workspace":{"workspace_id":42}}}'),
    ).toBeNull();
    expect(
      parseHerdrWorkspaceId(
        JSON.stringify({ result: { workspace: { workspace_id: "--tab" } } }),
      ),
    ).toBeNull();
  });

  // A workspace-create response seeds exactly one tab, which belongs to the workspace it was
  // just created in, so `.result.tab.workspace_id` reports the same id as
  // `.result.workspace.workspace_id` — falling back to it keeps cleanup able to target the
  // workspace (rather than a doomed tab close) even if the primary field is ever malformed.
  test("falls back to the seeded tab's workspace_id when the primary workspace field is missing", () => {
    expect(
      parseHerdrWorkspaceId(
        '{"result":{"tab":{"tab_id":"w4:t1","workspace_id":"w4"},"workspace":{}}}',
      ),
    ).toBe("w4");
    expect(
      parseHerdrWorkspaceId('{"result":{"tab":{"tab_id":"w4:t1"}}}'),
    ).toBeNull();
    expect(
      parseHerdrWorkspaceId(
        JSON.stringify({ result: { tab: { workspace_id: "--tab" } } }),
      ),
    ).toBeNull();
  });

  // Each candidate is validated independently rather than selected via `??`, which would only
  // skip a nullish primary field — not one that's present but invalid (empty string, wrong type,
  // fails HERDR_ID) — and so would wrongly discard a still-usable fallback.
  test("falls back to the tab's workspace_id when the primary field is present but malformed", () => {
    expect(
      parseHerdrWorkspaceId(
        '{"result":{"workspace":{"workspace_id":""},"tab":{"tab_id":"w4:t1","workspace_id":"w4"}}}',
      ),
    ).toBe("w4");
    expect(
      parseHerdrWorkspaceId(
        '{"result":{"workspace":{"workspace_id":42},"tab":{"tab_id":"w4:t1","workspace_id":"w4"}}}',
      ),
    ).toBe("w4");
    expect(
      parseHerdrWorkspaceId(
        JSON.stringify({
          result: {
            workspace: { workspace_id: "--tab" },
            tab: { workspace_id: "w4" },
          },
        }),
      ),
    ).toBe("w4");
  });

  test("does not map unspecified workflows to raw commands", () => {
    expect(commandForHerdrLaunch({ repo: "jugyo/loophub" })).toBe("");
  });

  test("collapses whitespace and truncates long agent name labels", () => {
    const longTitle = `Issue #444 - ${"a very long issue title ".repeat(6)}`;
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh dev 'jugyo/loophub/444'",
      label: longTitle,
    });
    const agentName = plan.argv[5];
    expect(agentName.length).toBeLessThanOrEqual(80);
    expect(agentName.endsWith("…")).toBe(true);
    expect(agentName).not.toMatch(/\s{2,}/);

    const multiline = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh dev 'jugyo/loophub/444'",
      label: "Issue #444 -\n  line two",
    });
    expect(multiline.argv[5]).toBe("Issue #444 - line two");
  });

  test("truncates long agent names on code points, not UTF-16 code units", () => {
    // 79 "a"s + two astral-plane emoji (each a surrogate pair) pushes the cut point (79) right
    // between the pair — a naive String#slice would emit an unpaired surrogate.
    const label = `${"a".repeat(79)}\u{1F600}\u{1F601}`;
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh dev 'jugyo/loophub/444'",
      label,
    });
    const agentName = plan.argv[5];
    expect(agentName).toBe(`${"a".repeat(79)}…`);
    expect(agentName).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  test("strips control, escape, and bidi-override characters from agent name labels", () => {
    const label =
      "Issue #444 - evil\x1b[31mtitle\x1b[0m\u200Ewith\u202Ehidden\u2066marks";
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh dev 'jugyo/loophub/444'",
      label,
    });
    // The ESC control byte itself is replaced with a space (so it can no longer start an escape
    // sequence, and doesn't glue the surrounding text together); the now-inert printable
    // remainder ("[31m", "[0m") is left as plain text.
    expect(plan.argv[5]).toBe(
      "Issue #444 - evil [31mtitle [0m with hidden marks",
    );
    expect(plan.argv[5]).not.toMatch(/\x1b/);
  });

  test("turns a bare newline/tab between words into a space instead of deleting it", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh dev 'jugyo/loophub/444'",
      label: "line1\nline2\tline3",
    });
    expect(plan.argv[5]).toBe("line1 line2 line3");
  });

  test("does not leave a double space when an unsafe char sits between two whitespace runs", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh dev 'jugyo/loophub/444'",
      label: "a \x01 b",
    });
    expect(plan.argv[5]).toBe("a b");
  });
});
