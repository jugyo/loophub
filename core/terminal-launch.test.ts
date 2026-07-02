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
});
