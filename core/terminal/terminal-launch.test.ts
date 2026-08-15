import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { updateConfig } from "../config.ts";
import {
  acquireHerdrWorktreeWorkspace,
  buildHerdrLaunchPlan,
  buildWorkflowStepHerdrLaunchPlan,
  commandForHerdrLaunch,
  executeHerdrLaunchPlan,
  HERDR_PANE_PLACEHOLDER,
  type HerdrCmdRunner,
  herdrAgentFocusArgv,
  herdrPaneCloseArgv,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrTabCreateInWorkspaceArgv,
  herdrTabFocusArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceCreateArgv,
  herdrWorkspaceFocusArgv,
  herdrWorkspaceListArgv,
  herdrWorktreeOpenArgv,
  parseHerdrAgentPaneId,
  parseHerdrRootPaneId,
  parseHerdrTabId,
  parseHerdrWorkspaceId,
  parseHerdrWorktreeOpenResult,
} from "./terminal-launch.ts";

describe("herdr terminal launch", () => {
  // commandForHerdrLaunch reads codingAgent from config.json when the caller doesn't override it
  // (#660) — isolate LOOPHUB_HOME per test so these tests assert
  // against a clean default config instead of whatever is in the developer's real ~/.loophub.
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevHome = process.env.LOOPHUB_HOME;
    home = mkdtempSync(join(tmpdir(), "lh-terminal-launch-"));
    process.env.LOOPHUB_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.LOOPHUB_HOME;
    } else {
      process.env.LOOPHUB_HOME = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
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
        workflow: "issue-create",
      }),
    ).toBe("lh issue new --repo 'jugyo/loophub'");
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        promptPath: "/home/launches/a.md",
        codingAgent: "claude-code",
      }),
    ).toBe(
      "claude '--permission-mode' 'auto' \"$(cat '/home/launches/a.md')\"",
    );
  });

  test("launches the coding agent with the workflow-create prompt as its initial input", () => {
    expect(
      commandForHerdrLaunch({
        repo: "loophub",
        workflow: "workflow-create",
        codingAgent: "claude-code",
        promptPath: "/home/launches/a.md",
      }),
    ).toBe(
      "claude '--permission-mode' 'auto' \"$(cat '/home/launches/a.md')\"",
    );
  });

  test("workflow-create without a prompt yields no command", () => {
    expect(
      commandForHerdrLaunch({
        repo: "loophub",
        workflow: "workflow-create",
        codingAgent: "claude-code",
      }),
    ).toBe("");
  });

  test("adds one-shot runtime, model, and effort flags to New Issue launches", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-create",
        codingAgent: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      }),
    ).toBe(
      "lh issue new --repo 'jugyo/loophub' --codex --model 'gpt-5.6-sol' --effort 'high'",
    );
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-create",
        codingAgent: "grok",
        model: "  vendor/custom model  ",
      }),
    ).toBe(
      "lh issue new --repo 'jugyo/loophub' --grok --model 'vendor/custom model'",
    );
  });

  test("adds the selected target branch to New Issue launches", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-create",
        targetBranch: "workspace/release candidate",
      }),
    ).toBe(
      "lh issue new --repo 'jugyo/loophub' --target-branch 'workspace/release candidate'",
    );
  });

  test("adds the parent issue to New Issue launches", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-create",
        parentIssue: 12,
      }),
    ).toBe("lh issue new --repo 'jugyo/loophub' --parent '12'");
  });

  test("passes a direct issue filing prompt to New Issue launches", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-create",
        prompt: "Create an issue; then stop.",
      }),
    ).toBe(
      "lh issue new --repo 'jugyo/loophub' --prompt 'Create an issue; then stop.'",
    );
  });

  test("uses the configured coding agent for GitHub PR export launches (#660)", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        promptPath: "/home/launches/a.md",
        codingAgent: "codex",
      }),
    ).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' \"$(cat '/home/launches/a.md')\"",
    );
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        promptPath: "/home/launches/a.md",
        codingAgent: "claude-code",
      }),
    ).toBe(
      "claude '--permission-mode' 'auto' \"$(cat '/home/launches/a.md')\"",
    );
  });

  test("yields no command for a GitHub PR export launch without a prompt", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        codingAgent: "claude-code",
      }),
    ).toBe("");
  });

  test("reads codingAgent config for GitHub PR export launches when no override is passed (#660)", () => {
    updateConfig({ codingAgent: "codex" });
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        promptPath: "/home/launches/a.md",
      }),
    ).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' \"$(cat '/home/launches/a.md')\"",
    );

    updateConfig({ codingAgent: "claude-code" });
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        promptPath: "/home/launches/a.md",
      }),
    ).toBe(
      "claude '--permission-mode' 'auto' \"$(cat '/home/launches/a.md')\"",
    );
  });

  test("launches GitHub PR export in auto mode", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        promptPath: "/home/launches/a.md",
        codingAgent: "claude-code",
      }),
    ).toBe(
      "claude '--permission-mode' 'auto' \"$(cat '/home/launches/a.md')\"",
    );

    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        promptPath: "/home/launches/a.md",
        codingAgent: "codex",
      }),
    ).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' \"$(cat '/home/launches/a.md')\"",
    );
  });

  test("shell-quotes repo names in generated workflows", () => {
    expect(
      commandForHerdrLaunch({
        repo: "bad/re'po; touch nope",
        workflow: "issue-create",
      }),
    ).toBe("lh issue new --repo 'bad/re'\\''po; touch nope'");
  });

  test("prefixes New Issue commands with a shell-quoted launch correlation env var", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-create",
        env: { LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH: "launch-1" },
      }),
    ).toBe(
      "LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH='launch-1' lh issue new --repo 'jugyo/loophub'",
    );
  });

  test("builds a pane-first Herdr launch plan", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const plan = buildHerdrLaunchPlan({
      repo,
      command: "claude --model sonnet",
      env: { LOOPHUB_SESSION_ID: "s-1" },
      label: "dev #444",
      workspaceId: "w1",
    });
    // The pane is created first; its environment rides on the creating call, because the command is
    // typed into that pane's shell and inherits nothing else.
    expect(plan.paneArgv).toEqual([
      "herdr",
      "--session",
      plan.sessionName,
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repo/main",
      "--env",
      "LOOPHUB_SESSION_ID=s-1",
      "--no-focus",
    ]);
    // The whole command is then typed into that pane's shell.
    expect(plan.argv).toEqual([
      "herdr",
      "--session",
      plan.sessionName,
      "pane",
      "send-text",
      HERDR_PANE_PLACEHOLDER,
      "claude --model sonnet\n",
    ]);
    // The human-readable label is applied separately; it is the only identity LoopHub reads back.
    expect(plan.label).toBe("dev #444");
    expect(plan.renameArgv).toEqual([
      "herdr",
      "--session",
      plan.sessionName,
      "pane",
      "rename",
      HERDR_PANE_PLACEHOLDER,
      "dev #444",
    ]);
  });

  // #2354: the prompt rides on the command line, read back from a file, so starting the agent and
  // instructing it are one step. Nothing about the multi-line, quote-bearing prompt text reaches an
  // argv token, and nothing is left to deliver afterwards.
  test("a Workflow step reads its prompt back from a file on the command line", () => {
    const plan = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      runId: 12,
      step: "execute",
      sequence: 1,
      runtime: "codex",
      sessionId: "11111111-1111-4111-8111-111111111111",
      worktree: "/repo/worktrees/pr-7",
      systemPromptPath: "/tmp/run/execute-contract.md",
      userPromptPath: "/tmp/run/execute-prompt.md",
      splitPaneId: "w1:p2",
      model: "gpt-5.5",
      effort: "high",
    });
    expect(plan.command).toContain("\"$(cat '/tmp/run/execute-prompt.md')\"");
    // The typed line is the whole launch: one send-text call, no follow-up.
    expect(plan.argv.slice(3, 5)).toEqual(["pane", "send-text"]);
    expect(plan.argv.at(-1)).toBe(`${plan.command}\n`);
  });

  test("a launch whose entrypoint is not a runtime binary types its command the same way", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const plan = buildHerdrLaunchPlan({
      repo,
      command: "lh issue new --repo 'jugyo/loophub'",
      label: "New issue",
    });
    expect(plan.argv).toEqual([
      "herdr",
      "--session",
      plan.sessionName,
      "pane",
      "send-text",
      HERDR_PANE_PLACEHOLDER,
      "lh issue new --repo 'jugyo/loophub'\n",
    ]);
  });

  test("cwd overrides repo.local_path without changing the session name (#584)", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const plan = buildHerdrLaunchPlan({
      repo,
      command: "claude '--session-id' 'x'",
      label: "#12 dev",
      cwd: "/repo/worktrees/pr-12",
    });
    expect(plan.sessionName).toBe(herdrSessionName(repo));
    expect(plan.cwd).toBe("/repo/worktrees/pr-12");
    // With no workspace to scope it to, the pane comes from a plain tab at the launch cwd.
    expect(plan.paneArgv[plan.paneArgv.indexOf("--cwd") + 1]).toBe(
      "/repo/worktrees/pr-12",
    );
    expect(plan.paneArgv).not.toContain("--workspace");
  });

  // #873: a known worktree workspace places the launch's tab there instead of wherever herdr's
  // focus happens to be (an unrelated PR's pane).
  test("creates the launch tab inside the given workspace", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "claude",
      label: "dev #444",
      workspaceId: "w9",
      cwd: "/repo/worktrees/pr-42",
    });
    expect(plan.paneArgv).toContain("--workspace");
    expect(plan.paneArgv[plan.paneArgv.indexOf("--workspace") + 1]).toBe("w9");
  });

  test("a split placement wins over a workspace: the child lands in its parent's tab", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "claude",
      label: "executor #1-1",
      splitPaneId: "w9:p2",
      split: "down",
      workspaceId: "w9",
    });
    expect(plan.paneArgv).toContain("split");
    expect(plan.paneArgv).toContain("w9:p2");
    expect(plan.paneArgv[plan.paneArgv.indexOf("--direction") + 1]).toBe(
      "down",
    );
    expect(plan.paneArgv).not.toContain("create");
  });

  test("executeHerdrLaunchPlan runs pane, rename, then the command with the real pane id", async () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "claude",
      label: "dev #1",
    });
    const calls: string[][] = [];
    const outcome = await executeHerdrLaunchPlan(plan, async (argv) => {
      calls.push(argv);
      return {
        stdout: argv.includes("create")
          ? '{"result":{"root_pane":{"pane_id":"w1:p5"},"tab":{"tab_id":"w1:t5"}}}'
          : "{}",
        stderr: "",
        ok: true,
      };
    });
    expect(outcome).toMatchObject({
      ok: true,
      paneId: "w1:p5",
      tabId: "w1:t5",
    });
    expect(calls.map((argv) => argv.slice(3, 5))).toEqual([
      ["tab", "create"],
      ["pane", "rename"],
      ["pane", "send-text"],
    ]);
    // No placeholder survives into an executed call.
    expect(calls.flat()).not.toContain(HERDR_PANE_PLACEHOLDER);
    expect(calls[2]).toContain("w1:p5");
  });

  test("executeHerdrLaunchPlan reports which step failed", async () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "claude",
      label: "dev #1",
    });
    const runner =
      (sendText: { ok: boolean; stderr: string }) => async (argv: string[]) => {
        if (!argv.includes("send-text"))
          return {
            stdout: '{"result":{"root_pane":{"pane_id":"w1:p5"}}}',
            stderr: "",
            ok: true,
          };
        return { stdout: "", ...sendText };
      };
    expect(
      await executeHerdrLaunchPlan(plan, runner({ ok: true, stderr: "" })),
    ).toMatchObject({ ok: true, paneId: "w1:p5", failed: null });
    expect(
      await executeHerdrLaunchPlan(
        plan,
        runner({ ok: false, stderr: '{"error":{"code":"pane_not_found"}}' }),
      ),
    ).toMatchObject({ ok: false, failed: "agent", paneId: "w1:p5" });
  });

  test("builds Workflow step Herdr split launch argv and ambient env", () => {
    const plan = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      runId: 12,
      step: "execute",
      sequence: 1,
      runtime: "claude-code",
      sessionId: "11111111-1111-4111-8111-111111111111",
      worktree: "/repo/worktrees/pr-7",
      systemPromptPath: "/tmp/run/execute-contract.md",
      userPromptPath: "/tmp/run/execute-prompt.md",
      splitPaneId: "w1:p2",
      model: "sonnet",
    });

    expect(plan.cwd).toBe("/repo/worktrees/pr-7");
    // The child pane is a split of the run's parent pane, so it lands in the run's own tab.
    expect(plan.paneArgv).toContain("split");
    expect(plan.paneArgv).toContain("w1:p2");
    expect(plan.paneArgv[plan.paneArgv.indexOf("--direction") + 1]).toBe(
      "down",
    );
    expect(plan.paneArgv[plan.paneArgv.indexOf("--cwd") + 1]).toBe(
      "/repo/worktrees/pr-7",
    );
    // The ambient LOOPHUB_* env is set on that pane, not folded into a shell command line.
    expect(plan.paneArgv).toContain(
      "LOOPHUB_SESSION_ID=11111111-1111-4111-8111-111111111111",
    );
    expect(plan.paneArgv).toContain("LOOPHUB_WORKFLOW_RUN=12");
    expect(plan.command).toContain(
      "LOOPHUB_SESSION_ID='11111111-1111-4111-8111-111111111111'",
    );
    expect(plan.command).toContain("LOOPHUB_WORKFLOW_REPO='jugyo/loophub'");
    expect(plan.command).toContain("LOOPHUB_WORKFLOW_RUN='12'");
    expect(plan.command).toContain("LOOPHUB_WORKFLOW_STEP='execute'");
    expect(plan.command).toContain(
      "claude '--session-id' '11111111-1111-4111-8111-111111111111'",
    );
    expect(plan.command).toContain("'--model' 'sonnet'");
    expect(plan.command).toContain("'--permission-mode' 'auto'");
    expect(plan.command).toContain(
      "'--append-system-prompt-file' '/tmp/run/execute-contract.md'",
    );
    // The claude branch does not carry a codex sandbox flag.
    expect(plan.command).not.toContain("--sandbox");
  });

  test("builds a Codex Workflow step launch with no claude-only flags (#516)", () => {
    const plan = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      runId: 12,
      step: "execute",
      sequence: 1,
      runtime: "codex",
      sessionId: "11111111-1111-4111-8111-111111111111",
      worktree: "/repo/worktrees/pr-7",
      systemPromptPath: "/tmp/run/execute-contract.md",
      userPromptPath: "/tmp/run/execute-prompt.md",
      splitPaneId: "w1:p2",
      model: "gpt-5.5",
      effort: "high",
    });

    // Codex still correlates through the ambient session env, but never gets a --session-id flag.
    expect(plan.command).toContain(
      "LOOPHUB_SESSION_ID='11111111-1111-4111-8111-111111111111'",
    );
    expect(plan.command).toContain("codex ");
    expect(plan.command).not.toContain("claude");
    expect(plan.command).not.toContain("--session-id");
    expect(plan.command).not.toContain("--append-system-prompt-file");
    // auto mode bypasses approvals/sandbox, matching the interactive Build button's Codex posture.
    expect(plan.command).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(plan.command).toContain("'--model' 'gpt-5.5'");
    expect(plan.command).toContain("'-c' 'model_reasoning_effort=high'");
    // codex has no --append-system-prompt-file, so its prompt file is where the folded contract
    // lives; the command line only points at it.
    expect(plan.command).toContain("\"$(cat '/tmp/run/execute-prompt.md')\"");
  });

  test("a Codex Workflow step always bypasses approvals and sandbox", () => {
    const plan = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      runId: 3,
      step: "execute",
      sequence: 1,
      runtime: "codex",
      sessionId: "22222222-2222-4222-8222-222222222222",
      worktree: "/repo/worktrees/pr-7",
      systemPromptPath: "/tmp/run/execute-contract.md",
      userPromptPath: "/tmp/run/execute-prompt.md",
      model: "gpt-5.5",
    });

    expect(plan.command).not.toContain("'--sandbox' 'workspace-write'");
    expect(plan.command).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  test("builds a Grok Workflow step launch with no claude-only flags (#1521)", () => {
    const plan = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      runId: 12,
      step: "execute",
      sequence: 1,
      runtime: "grok",
      sessionId: "11111111-1111-4111-8111-111111111111",
      worktree: "/repo/worktrees/pr-7",
      systemPromptPath: "/tmp/run/execute-contract.md",
      userPromptPath: "/tmp/run/execute-prompt.md",
      splitPaneId: "w1:p2",
      model: "grok-code-fast-1",
    });

    // Grok correlates through the ambient session env like Codex, and never gets a --session-id flag.
    expect(plan.command).toContain(
      "LOOPHUB_SESSION_ID='11111111-1111-4111-8111-111111111111'",
    );
    expect(plan.command).toContain("grok ");
    expect(plan.command).not.toContain("claude");
    expect(plan.command).not.toContain("codex");
    expect(plan.command).not.toContain("--session-id");
    expect(plan.command).not.toContain("--append-system-prompt-file");
    // auto mode opts into grok's `--always-approve` approval bypass; grok has no sandbox posture.
    expect(plan.command).toContain("--always-approve");
    // Current grok CLIs reject the old tentative `--force` flag (#1540).
    expect(plan.command).not.toContain("--force");
    expect(plan.command).not.toContain("--sandbox");
    expect(plan.command).toContain("'--model' 'grok-code-fast-1'");
    expect(plan.command).toContain("\"$(cat '/tmp/run/execute-prompt.md')\"");
  });

  test("a Grok Workflow step always includes the approval bypass", () => {
    const plan = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      runId: 3,
      step: "execute",
      sequence: 1,
      runtime: "grok",
      sessionId: "22222222-2222-4222-8222-222222222222",
      worktree: "/repo/worktrees/pr-7",
      systemPromptPath: "/tmp/run/execute-contract.md",
      userPromptPath: "/tmp/run/execute-prompt.md",
      model: "grok-code-fast-1",
    });

    expect(plan.command).toContain("grok ");
    expect(plan.command).toContain("--always-approve");
    expect(plan.command).not.toContain("--force");
    expect(plan.command).not.toContain("--sandbox");
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
    expect(herdrWorkspaceCreateArgv(repo, "New Issue")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "workspace",
      "create",
      "--cwd",
      "/repo/main",
      "--label",
      "New Issue",
      "--no-focus",
    ]);
    expect(herdrWorkspaceListArgv(repo)).toEqual([
      "herdr",
      "--session",
      sessionName,
      "workspace",
      "list",
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

  test("builds Herdr workspace focus argv scoped to the repo session (#556)", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const sessionName = herdrSessionName(repo);
    expect(herdrWorkspaceFocusArgv(repo, "w4")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "workspace",
      "focus",
      "w4",
    ]);
  });

  test("builds Herdr tab focus argv scoped to the repo session (#625)", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const sessionName = herdrSessionName(repo);
    expect(herdrTabFocusArgv(repo, "w1:t9")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "tab",
      "focus",
      "w1:t9",
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

  test("builds Herdr agent focus argv scoped to the repo session (#578)", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const sessionName = herdrSessionName(repo);
    expect(herdrAgentFocusArgv(repo, "w1:p2")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "agent",
      "focus",
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

  test("parses the agent pane id from herdr agent start output", () => {
    expect(
      parseHerdrAgentPaneId(
        '{"result":{"agent":{"name":"New issue","pane_id":"w4:p2"}}}',
      ),
    ).toBe("w4:p2");
    expect(
      parseHerdrAgentPaneId('{"result":{"pane":{"pane_id":"w4:p3"}}}'),
    ).toBe("w4:p3");
    expect(parseHerdrAgentPaneId('{"result":{"pane_id":"w4:p4"}}')).toBe(
      "w4:p4",
    );
    expect(parseHerdrAgentPaneId("")).toBeNull();
    expect(parseHerdrAgentPaneId("not json")).toBeNull();
    expect(
      parseHerdrAgentPaneId('{"result":{"agent":{"pane_id":"--bad"}}}'),
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
      command:
        "lh workflow start 'jugyo/loophub/444' --workflow default --herdr",
      label: longTitle,
    });
    const agentName = plan.label;
    expect(agentName.length).toBeLessThanOrEqual(80);
    expect(agentName.endsWith("…")).toBe(true);
    expect(agentName).not.toMatch(/\s{2,}/);

    const multiline = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command:
        "lh workflow start 'jugyo/loophub/444' --workflow default --herdr",
      label: "Issue #444 -\n  line two",
    });
    expect(multiline.label).toBe("Issue #444 - line two");
  });

  test("truncates long agent names on code points, not UTF-16 code units", () => {
    // 79 "a"s + two astral-plane emoji (each a surrogate pair) pushes the cut point (79) right
    // between the pair — a naive String#slice would emit an unpaired surrogate.
    const label = `${"a".repeat(79)}\u{1F600}\u{1F601}`;
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command:
        "lh workflow start 'jugyo/loophub/444' --workflow default --herdr",
      label,
    });
    const agentName = plan.label;
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
      command:
        "lh workflow start 'jugyo/loophub/444' --workflow default --herdr",
      label,
    });
    // The ESC control byte itself is replaced with a space (so it can no longer start an escape
    // sequence, and doesn't glue the surrounding text together); the now-inert printable
    // remainder ("[31m", "[0m") is left as plain text.
    expect(plan.label).toBe(
      "Issue #444 - evil [31mtitle [0m with hidden marks",
    );
    expect(plan.label).not.toMatch(/\x1b/);
  });

  test("turns a bare newline/tab between words into a space instead of deleting it", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command:
        "lh workflow start 'jugyo/loophub/444' --workflow default --herdr",
      label: "line1\nline2\tline3",
    });
    expect(plan.label).toBe("line1 line2 line3");
  });

  test("does not leave a double space when an unsafe char sits between two whitespace runs", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command:
        "lh workflow start 'jugyo/loophub/444' --workflow default --herdr",
      label: "a \x01 b",
    });
    expect(plan.label).toBe("a b");
  });

  // #551: herdr launches (issue-dev/resume/github-pr-export) open the PR's real worktree via
  // `herdr worktree open --path` instead of a plain tab cd'd there by the launched command.
  test("builds Herdr worktree open argv scoped to the repo session", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const sessionName = herdrSessionName(repo);
    expect(herdrWorktreeOpenArgv(repo, "/wt/pr-42")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "worktree",
      "open",
      // #873: source the open from the repo parent workspace, so herdr doesn't refuse it
      // (`linked_worktree_source`) when another PR's linked-worktree workspace is focused.
      "--cwd",
      "/repo/main",
      "--path",
      "/wt/pr-42",
      "--no-focus",
    ]);
  });

  test("builds Herdr tab create argv scoped to an already-open worktree workspace", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const sessionName = herdrSessionName(repo);
    expect(herdrTabCreateInWorkspaceArgv(repo, "w7", "/wt/pr-42")).toEqual([
      "herdr",
      "--session",
      sessionName,
      "tab",
      "create",
      "--workspace",
      "w7",
      "--cwd",
      "/wt/pr-42",
      "--no-focus",
    ]);
  });

  test("parses already_open and workspace_id from herdr worktree open output", () => {
    expect(
      parseHerdrWorktreeOpenResult(
        '{"id":"cli:worktree:open","result":{"already_open":false,"workspace":{"workspace_id":"wB"},"tab":{"tab_id":"wB:t1"},"root_pane":{"pane_id":"wB:p1"},"type":"worktree_opened"}}',
      ),
    ).toEqual({ alreadyOpen: false, workspaceId: "wB" });
    expect(
      parseHerdrWorktreeOpenResult(
        '{"result":{"already_open":true,"workspace":{"workspace_id":"w7"}}}',
      ),
    ).toEqual({ alreadyOpen: true, workspaceId: "w7" });
    expect(parseHerdrWorktreeOpenResult("")).toBeNull();
    expect(parseHerdrWorktreeOpenResult("not json")).toBeNull();
    // Missing already_open collapses to false rather than throwing — an unrecognized/older herdr
    // response shape should not be mistaken for "safe to reuse the returned tab directly".
    expect(parseHerdrWorktreeOpenResult('{"result":{"workspace":{}}}')).toEqual(
      { alreadyOpen: false, workspaceId: null },
    );
  });

  test("rejects a workspace id that could be parsed as a flag or shell noise", () => {
    const wrap = (id: string) =>
      JSON.stringify({
        result: { already_open: true, workspace: { workspace_id: id } },
      });
    expect(parseHerdrWorktreeOpenResult(wrap("--workspace"))?.workspaceId).toBe(
      null,
    );
    expect(parseHerdrWorktreeOpenResult(wrap("w7"))?.workspaceId).toBe("w7");
  });
});

// #674: Workflow / herdr launchers reuse this same open+tab-create dance so they land in
// the worktree's own herdr workspace instead of splitting the focused pane. The orchestration is
// spawn-agnostic via an injected runner, so these exercise it with a scripted fake.
describe("acquireHerdrWorktreeWorkspace", () => {
  const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
  const worktree = "/wt/pr-42";

  // Records each herdr argv and replays scripted responses in order; a request past the end
  // defaults to a bland success, so a test only scripts the calls it cares about.
  function scriptedRunner(
    responses: Array<{ stdout?: string; ok?: boolean }>,
  ): { run: HerdrCmdRunner; calls: string[][] } {
    const calls: string[][] = [];
    let i = 0;
    const run: HerdrCmdRunner = async (argv) => {
      calls.push(argv);
      const r = responses[i++] ?? {};
      return { stdout: r.stdout ?? "", ok: r.ok ?? true };
    };
    return { run, calls };
  }

  test("a first-time worktree open takes the tab from the open response (one call)", async () => {
    const { run, calls } = scriptedRunner([
      {
        stdout:
          '{"result":{"already_open":false,"workspace":{"workspace_id":"wB"},"tab":{"tab_id":"wB:t1"},"root_pane":{"pane_id":"wB:p1"}}}',
      },
    ]);
    const acquired = await acquireHerdrWorktreeWorkspace(repo, worktree, run);
    expect(acquired).toEqual({
      workspaceId: "wB",
      createdWorkspace: true,
      // The seeded tab carries none of the launch's `--env`, so the launch makes its own and this
      // one is dropped afterwards.
      seedTabId: "wB:t1",
    });
    // Only the open call: the launch's own tab is created later, as part of its plan.
    expect(calls).toEqual([herdrWorktreeOpenArgv(repo, worktree)]);
  });

  test("a reused workspace is returned without being touched", async () => {
    const { run, calls } = scriptedRunner([
      {
        stdout:
          '{"result":{"already_open":true,"workspace":{"workspace_id":"w7"}}}',
      },
    ]);
    const acquired = await acquireHerdrWorktreeWorkspace(repo, worktree, run);
    expect(acquired).toEqual({
      workspaceId: "w7",
      // A reused workspace predates this call, so it is not ours to close on failure — and its
      // existing tabs are not ours to drop either.
      createdWorkspace: false,
      seedTabId: null,
    });
    expect(calls).toEqual([herdrWorktreeOpenArgv(repo, worktree)]);
  });

  test("a failed worktree open returns null without a follow-up call", async () => {
    const { run, calls } = scriptedRunner([{ ok: false }]);
    expect(await acquireHerdrWorktreeWorkspace(repo, worktree, run)).toBeNull();
    expect(calls).toEqual([herdrWorktreeOpenArgv(repo, worktree)]);
  });

  test("unparseable open output returns null (caller falls back to a plain tab)", async () => {
    const { run } = scriptedRunner([{ stdout: "not json" }]);
    expect(await acquireHerdrWorktreeWorkspace(repo, worktree, run)).toBeNull();
  });

  test("a reused workspace with no usable workspace id returns null", async () => {
    const { run, calls } = scriptedRunner([
      { stdout: '{"result":{"already_open":true}}' },
    ]);
    expect(await acquireHerdrWorktreeWorkspace(repo, worktree, run)).toBeNull();
    // No tab-create attempt when there is no workspace to scope it to.
    expect(calls).toEqual([herdrWorktreeOpenArgv(repo, worktree)]);
  });
});
