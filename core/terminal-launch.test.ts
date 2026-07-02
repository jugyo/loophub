import { describe, expect, test } from "vitest";
import {
  buildHerdrLaunchPlan,
  commandForHerdrLaunch,
  herdrSessionName,
  normalizeTerminalLaunchBackend,
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
      "--no-focus",
      "--",
      "zsh",
      "-lc",
      "lh dev 'jugyo/loophub/444'",
    ]);
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
