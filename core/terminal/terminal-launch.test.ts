import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { updateAgentAutoModeOnBuild, updateConfig } from "../config.ts";
import {
  acquireHerdrWorktreeTab,
  buildHerdrLaunchPlan,
  buildWorkflowStepHerdrLaunchPlan,
  commandForHerdrLaunch,
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
  herdrWorktreeOpenArgv,
  parseHerdrAgentPaneId,
  parseHerdrRootPaneId,
  parseHerdrTabId,
  parseHerdrWorkspaceId,
  parseHerdrWorktreeOpenResult,
} from "./terminal-launch.ts";

describe("herdr terminal launch", () => {
  // commandForHerdrLaunch reads codingAgent/autoModeOnBuild from config.json when the caller
  // doesn't override them (#660, #809) — isolate LOOPHUB_HOME per test so these tests assert
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
        workflow: "scheduled-task-create",
        codingAgent: "claude-code",
      }),
    ).toBe("claude '/lh-scheduled-task-create'");
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        codingAgent: "claude-code",
      }),
    ).toBe("claude '/lh-create-github-pr 451'");
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "resume",
        session: "session-1",
        cwd: "/tmp/work tree",
      }),
    ).toBe("cd '/tmp/work tree' && claude --resume 'session-1'");
  });

  test("adds one-shot runtime and model flags to New Issue launches", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "issue-create",
        codingAgent: "codex",
        model: "gpt-5.6-sol",
      }),
    ).toBe("lh issue new --repo 'jugyo/loophub' --codex --model 'gpt-5.6-sol'");
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

  test("uses the configured coding agent for GitHub PR export launches (#660)", () => {
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        codingAgent: "codex",
      }),
    ).toBe(
      `codex '--sandbox' 'workspace-write' '-c' 'sandbox_workspace_write.writable_roots=[${JSON.stringify(home)}]' '/lh-create-github-pr 451'`,
    );
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        codingAgent: "claude-code",
      }),
    ).toBe("claude '/lh-create-github-pr 451'");
  });

  test("does not apply build auto-mode to scheduled task creation launches", () => {
    updateAgentAutoModeOnBuild("codex", true);
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "scheduled-task-create",
        codingAgent: "codex",
      }),
    ).toBe(
      `codex '--sandbox' 'workspace-write' '-c' 'sandbox_workspace_write.writable_roots=[${JSON.stringify(home)}]' '/lh-scheduled-task-create'`,
    );

    updateAgentAutoModeOnBuild("claude-code", true);
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "scheduled-task-create",
        codingAgent: "claude-code",
      }),
    ).toBe("claude '/lh-scheduled-task-create'");
  });

  test("reads codingAgent config for GitHub PR export launches when no override is passed (#660)", () => {
    updateConfig({ codingAgent: "codex" });
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
      }),
    ).toBe(
      `codex '--sandbox' 'workspace-write' '-c' 'sandbox_workspace_write.writable_roots=[${JSON.stringify(home)}]' '/lh-create-github-pr 451'`,
    );

    updateConfig({ codingAgent: "claude-code" });
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
      }),
    ).toBe("claude '/lh-create-github-pr 451'");
  });

  test("applies the agent's autoModeOnBuild setting to GitHub PR export launches (#809)", () => {
    // claude-code: --auto's equivalent is --permission-mode auto, same as lh build --auto
    // (buildClaudeArgs) — off by default (autoModeOnBuild unset).
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        codingAgent: "claude-code",
      }),
    ).toBe("claude '/lh-create-github-pr 451'");

    updateAgentAutoModeOnBuild("claude-code", true);
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        codingAgent: "claude-code",
      }),
    ).toBe("claude '--permission-mode' 'auto' '/lh-create-github-pr 451'");

    // codex: auto mode swaps the sandboxed --sandbox args for the same unsandboxed bypass
    // flag lh build --auto uses (buildCodexArgs), rather than adding a flag on top.
    updateAgentAutoModeOnBuild("codex", true);
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        codingAgent: "codex",
      }),
    ).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' '/lh-create-github-pr 451'",
    );

    // claude-code's setting must not leak into codex's launch, and vice versa (#593 parity).
    updateAgentAutoModeOnBuild("claude-code", false);
    expect(
      commandForHerdrLaunch({
        repo: "jugyo/loophub",
        workflow: "github-pr-export",
        prNumber: 451,
        codingAgent: "codex",
      }),
    ).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' '/lh-create-github-pr 451'",
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

  test("builds Herdr agent start argv without shell interpolation", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh build 'jugyo/loophub/444'",
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
      "lh build 'jugyo/loophub/444'",
    ]);
  });

  test("cwd overrides repo.local_path for --cwd without changing the session name (#584)", () => {
    const repo = { full_name: "jugyo/loophub", local_path: "/repo/main" };
    const plan = buildHerdrLaunchPlan({
      repo,
      command: "claude '--session-id' 'x'",
      label: "#12 dev",
      cwd: "/repo/worktrees/pr-12",
    });
    expect(plan.sessionName).toBe(herdrSessionName(repo));
    expect(plan.cwd).toBe("/repo/worktrees/pr-12");
    expect(plan.argv[plan.argv.indexOf("--cwd") + 1]).toBe(
      "/repo/worktrees/pr-12",
    );
  });

  test("omits --tab when tab creation did not yield an id (fallback to split)", () => {
    for (const tabId of [undefined, null]) {
      const plan = buildHerdrLaunchPlan({
        repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
        command: "lh build 'jugyo/loophub/444'",
        label: "dev #444",
        tabId,
      });
      expect(plan.argv).not.toContain("--tab");
    }
  });

  // #873: no tab id but a known worktree workspace — place via --workspace so the agent stays in
  // that workspace instead of splitting whatever pane is currently focused (an unrelated PR's).
  test("falls back to --workspace when tabId is null but a workspace id is given", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh build 'jugyo/loophub/444'",
      label: "dev #444",
      tabId: null,
      workspaceId: "w9",
      cwd: "/repo/worktrees/pr-42",
    });
    expect(plan.argv).not.toContain("--tab");
    expect(plan.argv).toContain("--workspace");
    expect(plan.argv[plan.argv.indexOf("--workspace") + 1]).toBe("w9");
  });

  // A usable tab id wins: --tab is exact placement, so a workspace id is redundant and omitted.
  test("prefers --tab over --workspace when both are available", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh build 'jugyo/loophub/444'",
      label: "dev #444",
      tabId: "w9:t2",
      workspaceId: "w9",
    });
    expect(plan.argv).toContain("--tab");
    expect(plan.argv).not.toContain("--workspace");
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
      systemPrompt: "# Execute contract\nstep: execute\n",
      userPrompt: "## Inputs\n- /tmp/run/execute/input/task.md - Task\n",
      tabId: "w1:t2",
      model: "sonnet",
      permissionMode: "auto",
    });

    expect(plan.cwd).toBe("/repo/worktrees/pr-7");
    expect(plan.argv).toContain("--split");
    expect(plan.argv[plan.argv.indexOf("--split") + 1]).toBe("down");
    expect(plan.argv).toContain("--tab");
    expect(plan.command).toContain(
      "LOOPHUB_SESSION_ID='11111111-1111-4111-8111-111111111111'",
    );
    expect(plan.command).toContain("LOOPHUB_WORKFLOW_RUN='12'");
    expect(plan.command).toContain("LOOPHUB_WORKFLOW_STEP='execute'");
    expect(plan.command).toContain(
      "claude --session-id '11111111-1111-4111-8111-111111111111'",
    );
    expect(plan.command).toContain("--model 'sonnet'");
    expect(plan.command).toContain("--permission-mode 'auto'");
    expect(plan.command).toContain(
      "--append-system-prompt-file '/tmp/run/execute-contract.md'",
    );
    // The claude branch does not carry a codex sandbox flag.
    expect(plan.command).not.toContain("--sandbox");
  });

  test("builds a Codex Workflow step launch that folds the contract into the prompt (#516)", () => {
    const plan = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      runId: 12,
      step: "execute",
      sequence: 1,
      runtime: "codex",
      sessionId: "11111111-1111-4111-8111-111111111111",
      worktree: "/repo/worktrees/pr-7",
      systemPromptPath: "/tmp/run/execute-contract.md",
      systemPrompt: "# Execute contract\nstep: execute\n",
      userPrompt: "## Inputs\n- task.md\n",
      tabId: "w1:t2",
      model: "gpt-5.5",
      permissionMode: "auto",
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
    expect(plan.command).toContain("--model 'gpt-5.5'");
    // The rendered contract is prepended to the positional prompt (single quoted as one arg).
    expect(plan.command).toContain("# Execute contract");
    expect(plan.command).toContain("## Inputs");
  });

  test("a non-auto Codex Workflow step runs inside the workspace-write sandbox (#516)", () => {
    const plan = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      runId: 3,
      step: "execute",
      sequence: 1,
      runtime: "codex",
      sessionId: "22222222-2222-4222-8222-222222222222",
      worktree: "/repo/worktrees/pr-7",
      systemPromptPath: "/tmp/run/execute-contract.md",
      systemPrompt: "contract",
      userPrompt: "do it",
      model: "gpt-5.5",
    });

    expect(plan.command).toContain("'--sandbox' 'workspace-write'");
    expect(plan.command).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
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
      command: "lh build 'jugyo/loophub/444'",
      label: longTitle,
    });
    const agentName = plan.argv[5];
    expect(agentName.length).toBeLessThanOrEqual(80);
    expect(agentName.endsWith("…")).toBe(true);
    expect(agentName).not.toMatch(/\s{2,}/);

    const multiline = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh build 'jugyo/loophub/444'",
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
      command: "lh build 'jugyo/loophub/444'",
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
      command: "lh build 'jugyo/loophub/444'",
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
      command: "lh build 'jugyo/loophub/444'",
      label: "line1\nline2\tline3",
    });
    expect(plan.argv[5]).toBe("line1 line2 line3");
  });

  test("does not leave a double space when an unsafe char sits between two whitespace runs", () => {
    const plan = buildHerdrLaunchPlan({
      repo: { full_name: "jugyo/loophub", local_path: "/repo/main" },
      command: "lh build 'jugyo/loophub/444'",
      label: "a \x01 b",
    });
    expect(plan.argv[5]).toBe("a b");
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

// #674: `lh build --herdr` (the Build button) reuses this same open+tab-create dance so it lands in
// the worktree's own herdr workspace instead of splitting the focused pane. The orchestration is
// spawn-agnostic via an injected runner, so these exercise it with a scripted fake.
describe("acquireHerdrWorktreeTab", () => {
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
    const acquired = await acquireHerdrWorktreeTab(repo, worktree, run);
    expect(acquired).toEqual({
      tabId: "wB:t1",
      rootPaneId: "wB:p1",
      workspaceId: "wB",
      targetWorkspaceId: "wB",
      createdWorkspace: true,
    });
    // Only the open call — a first-time open's seed tab is usable as-is, no follow-up tab create.
    expect(calls).toEqual([herdrWorktreeOpenArgv(repo, worktree)]);
  });

  test("a reused workspace opens a fresh tab inside it (open + tab create)", async () => {
    const { run, calls } = scriptedRunner([
      {
        stdout:
          '{"result":{"already_open":true,"workspace":{"workspace_id":"w7"}}}',
      },
      {
        stdout:
          '{"result":{"tab":{"tab_id":"w7:t3"},"root_pane":{"pane_id":"w7:p3"}}}',
      },
    ]);
    const acquired = await acquireHerdrWorktreeTab(repo, worktree, run);
    expect(acquired).toEqual({
      tabId: "w7:t3",
      rootPaneId: "w7:p3",
      // A reused workspace predates this call, so it is not ours to close on failure.
      workspaceId: null,
      // …but it is still the placement target for the `--workspace` fallback (#873).
      targetWorkspaceId: "w7",
      createdWorkspace: false,
    });
    expect(calls).toEqual([
      herdrWorktreeOpenArgv(repo, worktree),
      herdrTabCreateInWorkspaceArgv(repo, "w7", worktree),
    ]);
  });

  test("a failed worktree open returns null without a follow-up call", async () => {
    const { run, calls } = scriptedRunner([{ ok: false }]);
    expect(await acquireHerdrWorktreeTab(repo, worktree, run)).toBeNull();
    expect(calls).toEqual([herdrWorktreeOpenArgv(repo, worktree)]);
  });

  test("unparseable open output returns null (caller falls back to a plain tab)", async () => {
    const { run } = scriptedRunner([{ stdout: "not json" }]);
    expect(await acquireHerdrWorktreeTab(repo, worktree, run)).toBeNull();
  });

  test("a reused workspace with no usable workspace id returns null", async () => {
    const { run, calls } = scriptedRunner([
      { stdout: '{"result":{"already_open":true}}' },
    ]);
    expect(await acquireHerdrWorktreeTab(repo, worktree, run)).toBeNull();
    // No tab-create attempt when there is no workspace to scope it to.
    expect(calls).toEqual([herdrWorktreeOpenArgv(repo, worktree)]);
  });
});
