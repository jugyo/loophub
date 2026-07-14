import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { expect, test } from "vitest";
import {
  branchExists,
  git,
  gitCommonDir,
  gitDirOf,
  worktreeList,
} from "../core/git.ts";
import {
  acquireDevLock,
  buildClaudeArgs,
  buildCodexArgs,
  buildGrokArgs,
  buildManagedSettings,
  buildResumeArgs,
  buildRuntimeLaunch,
  devLockPath,
  displayMultiline,
  formatLaunchPlan,
  formatLaunchSummary,
  formatSpawnCommand,
  legacyWorktreeBranch,
  legacyWorktreePath,
  parseDevTarget,
  pidAlive,
  provisionWorktree,
  readDevLock,
  reconcileTargetRepo,
  removeDevLock,
  resolveDevRuntime,
  shouldCreateMissingConventionBranch,
  validateDomain,
  validateExistingLocalBranch,
  worktreeBranch,
  worktreePath,
} from "./dev.ts";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;

// ---- parseDevTarget (pure) ----

test("parseDevTarget accepts a bare numeric id (repo deferred to resolveRepo)", () => {
  expect(parseDevTarget("116")).toEqual({ id: 116 });
});

test("parseDevTarget accepts the <owner>/<repo>/<id> form", () => {
  expect(parseDevTarget("jugyo/loophub/116")).toEqual({
    repo: "jugyo/loophub",
    id: 116,
  });
});

test("parseDevTarget rejects a non-numeric bare id", () => {
  expect(() => parseDevTarget("foo")).toThrow(/invalid issue id/);
});

test("parseDevTarget rejects a two-segment target (owner/repo with no id)", () => {
  expect(() => parseDevTarget("jugyo/loophub")).toThrow(/invalid target/);
});

test("parseDevTarget rejects a four-segment target", () => {
  expect(() => parseDevTarget("a/b/c/116")).toThrow(/invalid target/);
});

test("parseDevTarget rejects owner/repo/id with a non-numeric id", () => {
  expect(() => parseDevTarget("jugyo/loophub/foo")).toThrow(/invalid target/);
});

test("parseDevTarget rejects an empty owner or repo segment", () => {
  expect(() => parseDevTarget("/loophub/116")).toThrow(/invalid target/);
  expect(() => parseDevTarget("jugyo//116")).toThrow(/invalid target/);
});

// ---- reconcileTargetRepo (pure) ----

test("reconcileTargetRepo returns the repo when positional and --repo match", () => {
  expect(reconcileTargetRepo("jugyo/loophub", "jugyo/loophub")).toBe(
    "jugyo/loophub",
  );
});

test("reconcileTargetRepo rejects conflicting positional and --repo values", () => {
  expect(() => reconcileTargetRepo("jugyo/loophub", "other/repo")).toThrow(
    "conflicting repo: positional 'jugyo/loophub' vs --repo 'other/repo'",
  );
});

test("reconcileTargetRepo returns the positional repo when --repo is absent", () => {
  expect(reconcileTargetRepo("jugyo/loophub", undefined)).toBe("jugyo/loophub");
});

test("reconcileTargetRepo returns --repo when the positional repo is absent", () => {
  expect(reconcileTargetRepo(undefined, "jugyo/loophub")).toBe("jugyo/loophub");
});

test("reconcileTargetRepo returns undefined when neither repo is provided", () => {
  expect(reconcileTargetRepo(undefined, undefined)).toBeUndefined();
});

// ---- displayMultiline (pure) ----

test("displayMultiline preserves newlines in a multi-line body", () => {
  const body = "First line\nSecond line\n\nFourth after blank";
  expect(displayMultiline(body)).toBe(
    "First line\nSecond line\n\nFourth after blank",
  );
});

test("displayMultiline strips ANSI/VT sequences and other control bytes but keeps \\n", () => {
  // \x1b[31m = red ANSI; \r and \b are line-overwriting control bytes; \n must survive.
  const body = "line one\x1b[31m red\r\nline\btwo";
  expect(displayMultiline(body)).toBe("line one red\nlinetwo");
});

// ---- managed settings (pure) ----

test("buildManagedSettings emits a sandboxed config with the default allow-list", () => {
  const { json, allowedDomains } = buildManagedSettings({
    repo: "jugyo/local-github",
  });
  expect(allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
  const s = JSON.parse(json);
  expect(s.sandbox.enabled).toBe(true);
  expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
  expect(s.sandbox.network.allowManagedDomainsOnly).toBe(true);
  expect(s.sandbox.network.allowedDomains).toEqual([
    "api.anthropic.com",
    "github.com",
  ]);
});

test("git paths produce a minimal branch-scoped write allow-list (not the whole gitdir)", () => {
  const { json } = buildManagedSettings({
    repo: "me/proj",
    git: {
      gitDir: "/repo/.git",
      worktreeGitDir: "/repo/.git/worktrees/issue-7",
      branch: "loophub/issue-7",
    },
  });
  const fs = JSON.parse(json).sandbox.filesystem;
  expect(fs.allowWrite).toEqual([
    "/repo/.git/objects",
    "/repo/.git/worktrees/issue-7",
    "/repo/.git/refs/heads/loophub/issue-7",
    "/repo/.git/refs/heads/loophub/issue-7.lock",
    "/repo/.git/logs/refs/heads/loophub/issue-7",
  ]);
  // The whole gitdir, other refs (main), hooks and config are NOT writable.
  expect(fs.allowWrite).not.toContain("/repo/.git");
  expect(fs.allowWrite.some((p: string) => p.includes("refs/heads/main"))).toBe(
    false,
  );
  expect(
    fs.allowWrite.some(
      (p: string) => p.endsWith("/hooks") || p.endsWith("/config"),
    ),
  ).toBe(false);
  // denyWrite should not be present.
  expect(fs.denyWrite).toBeUndefined();
  // denyRead is unchanged by the gitdir grant.
  expect(fs.denyRead).toContain("~/.ssh");
});

test("a detached worktree (no branch) grants no shared ref writes", () => {
  const { json } = buildManagedSettings({
    repo: "me/proj",
    git: {
      gitDir: "/repo/.git",
      worktreeGitDir: "/repo/.git/worktrees/x",
      branch: null,
    },
  });
  const fs = JSON.parse(json).sandbox.filesystem;
  expect(fs.allowWrite).toEqual([
    "/repo/.git/objects",
    "/repo/.git/worktrees/x",
  ]);
});

test("without git paths the filesystem config carries no write allow-list", () => {
  const { json } = buildManagedSettings({ repo: "me/proj" });
  const fs = JSON.parse(json).sandbox.filesystem;
  expect(fs.allowWrite).toBeUndefined();
  expect(fs.denyWrite).toBeUndefined();
});

test("--allow unions validated domains into the proxy allow-list", () => {
  const { allowedDomains } = buildManagedSettings({
    repo: "me/proj",
    allow: "example.com,*.test.dev",
  });
  expect(allowedDomains).toEqual([
    "api.anthropic.com",
    "github.com",
    "example.com",
    "*.test.dev",
  ]);
});

test("invalid --allow domain is rejected (injection guard)", () => {
  expect(() =>
    buildManagedSettings({ repo: "me/proj", allow: 'evil",":' }),
  ).toThrow(/invalid --allow domain/);
  expect(() => validateDomain('a"b')).toThrow(/invalid --allow domain/);
});

test("invalid --repo is rejected", () => {
  expect(() => buildManagedSettings({ repo: "not-a-repo" })).toThrow(
    /invalid --repo/,
  );
});

// ---- interactive launch args (pure) ----

test("buildClaudeArgs adds auto mode only when sandbox managed-settings are present", () => {
  // --sandbox → managed-settings present → auto mode passed explicitly so the live interactive
  // mode is driven regardless of how the settings `defaultMode` is merged.
  const sandboxed = buildClaudeArgs({
    sessionId: "sid-1",
    managedSettings: "{}",
    slashCommand: "/lh-build 42",
  });
  const i = sandboxed.indexOf("--permission-mode");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(sandboxed[i + 1]).toBe("auto");

  // No --sandbox → no managed-settings → no --permission-mode (Claude's normal approval mode),
  // so an unattended session never auto-edits without the sandbox guard rails.
  const plain = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
  });
  expect(plain.indexOf("--permission-mode")).toBe(-1);
});

test("buildClaudeArgs adds auto mode when --auto is set without the sandbox", () => {
  // --auto → auto mode without managed-settings (no sandbox guard rails), enabled only because
  // the user opted in explicitly.
  const auto = buildClaudeArgs({
    sessionId: "sid-1",
    auto: true,
    slashCommand: "/lh-build 42",
  });
  const i = auto.indexOf("--permission-mode");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(auto[i + 1]).toBe("auto");
  // No managed-settings → no --settings, even though auto mode is on.
  expect(auto.indexOf("--settings")).toBe(-1);

  // auto: false (default) → no auto mode, matching the non-flagged no-sandbox launch.
  const off = buildClaudeArgs({
    sessionId: "sid-1",
    auto: false,
    slashCommand: "/lh-build 42",
  });
  expect(off.indexOf("--permission-mode")).toBe(-1);
});

test("buildClaudeArgs carries session id, managed settings, and the slash command", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    managedSettings: "{}",
    slashCommand: "/lh-build 42",
  });
  expect(args[args.indexOf("--session-id") + 1]).toBe("sid-1");
  // The settings JSON must ride on `--settings` (the real claude flag), not the long-gone
  // `--managed-settings`, which claude silently dropped — sandbox + auto mode never applied.
  expect(args[args.indexOf("--settings") + 1]).toBe("{}");
  expect(args.indexOf("--managed-settings")).toBe(-1);
  expect(args[args.length - 1]).toBe("/lh-build 42");
});

test("buildResumeArgs resumes a UUID session id with no extra flags", () => {
  // `lh resume` re-enters an existing session: just `claude --resume <id>`, no --session-id,
  // slash command, or sandbox settings.
  expect(
    buildResumeArgs({ sessionId: "d8a43602-f469-4b03-8fa8-0af5200f22b3" }),
  ).toEqual(["--resume", "d8a43602-f469-4b03-8fa8-0af5200f22b3"]);
});

test("buildResumeArgs rejects a flag-like / non-UUID session id (argv injection guard)", () => {
  expect(() =>
    buildResumeArgs({ sessionId: "--dangerously-skip-permissions" }),
  ).toThrow(/invalid session id/);
  expect(() => buildResumeArgs({ sessionId: "sid-9" })).toThrow(
    /invalid session id/,
  );
});

test("buildClaudeArgs omits --settings when not provided (no-sandbox mode)", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
  });
  expect(args.indexOf("--settings")).toBe(-1);
  expect(args[args.indexOf("--session-id") + 1]).toBe("sid-1");
  // No sandbox → no auto mode.
  expect(args.indexOf("--permission-mode")).toBe(-1);
  expect(args[args.length - 1]).toBe("/lh-build 42");
});

test("buildClaudeArgs sets --name to the session name and keeps the slash command last", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/loophub-dev 42",
    sessionName: "#42 Fix the bug",
  });
  expect(args[args.indexOf("--name") + 1]).toBe("#42 Fix the bug");
  expect(args[args.length - 1]).toBe("/loophub-dev 42");
});

test("buildClaudeArgs omits --name when no session name is provided", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/loophub-dev 42",
  });
  expect(args.indexOf("--name")).toBe(-1);
});

test("buildClaudeArgs strips control characters from the session name before argv", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/loophub-dev 42",
    sessionName: "#42 \x1b[31mred\x1b[0m\r title\x07",
  });
  const name = args[args.indexOf("--name") + 1];
  expect(name).toBe("#42 red title");
  expect(name).not.toMatch(/[\x00-\x1f\x7f]/);
});

test("buildClaudeArgs omits --name when the session name is only control characters", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/loophub-dev 42",
    sessionName: "\x1b[0m\r\x07",
  });
  expect(args.indexOf("--name")).toBe(-1);
});

test("buildClaudeArgs passes --model through verbatim and keeps the slash command last", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
    model: "sonnet",
  });
  expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  expect(args[args.length - 1]).toBe("/lh-build 42");
});

test("buildClaudeArgs omits --model when not provided (backend default model)", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
  });
  expect(args.indexOf("--model")).toBe(-1);
});

test("buildClaudeArgs strips control characters from the model before argv", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
    model: "\x1b]0;x\x07sonnet\r",
  });
  expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
});

test("buildClaudeArgs omits --model when the model is only control characters", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
    model: "\x1b[0m\r\x07",
  });
  expect(args.indexOf("--model")).toBe(-1);
});

// ---- launch plan (pure) ----

function plan(overrides: Partial<Parameters<typeof formatLaunchPlan>[0]> = {}) {
  const { json } = buildManagedSettings({
    repo: "me/proj",
    allow: "example.com",
  });
  const claudeArgs = buildClaudeArgs({
    sessionId: "sid-1",
    managedSettings: json,
    slashCommand: "/lh-build 42",
  });
  return formatLaunchPlan({
    repo: "me/proj",
    worktree: "/root/me/proj/issue-42",
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
    managedSettings: json,
    claudeArgs,
    ...overrides,
  });
}

test("formatLaunchPlan shows context (repo / worktree / session / command)", () => {
  const out = plan();
  expect(out).toContain("repo:        me/proj");
  expect(out).toContain("worktree:    /root/me/proj/issue-42");
  expect(out).toContain("session-id:  sid-1");
  expect(out).toContain("command:     /lh-build 42");
});

test("formatLaunchPlan summarizes the managed sandbox settings (not raw JSON)", () => {
  const out = plan();
  expect(out).toContain("sandbox:            enabled (fail if unavailable)");
  expect(out).toContain("unsandboxed cmds:   denied");
  expect(out).toContain("excluded cmds:      gh *");
  expect(out).toContain(
    "network domains:    api.anthropic.com, github.com, example.com (managed only)",
  );
  expect(out).toContain("permissions mode:   auto");
  expect(out).toContain("filesystem denyRead:");
  expect(out).toContain("- ~/.ssh");
  // readable summary, never a raw one-line JSON blob
  expect(out).not.toContain('{"sandbox"');
});

test("formatLaunchPlan reports the --permission-mode passed on the command line", () => {
  const out = plan();
  expect(out).toContain("--permission-mode:  auto");
});

test("formatLaunchPlan shows no permission mode for a no-sandbox launch", () => {
  // No --sandbox: managed-settings empty and buildClaudeArgs omits --permission-mode, so the
  // plan must consistently report both as (default) — Claude's normal approval mode.
  const claudeArgs = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
  });
  const out = formatLaunchPlan({
    repo: "me/proj",
    worktree: "/root/me/proj/issue-42",
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
    managedSettings: "{}",
    claudeArgs,
  });
  expect(out).toContain("sandbox:            disabled");
  expect(out).toContain("permissions mode:   (default)");
  expect(out).toContain("--permission-mode:  (default)");
});

test("formatLaunchPlan tolerates missing managed-settings fields without throwing", () => {
  const out = formatLaunchPlan({
    repo: "me/proj",
    worktree: "/wt",
    sessionId: "sid",
    slashCommand: "/lh-build 1",
    managedSettings: "{}",
    claudeArgs: [], // no --permission-mode
  });
  expect(out).toContain("sandbox:            disabled");
  expect(out).toContain("excluded cmds:      (none)");
  expect(out).toContain("network domains:    (none)");
  expect(out).toContain("permissions mode:   (default)");
  expect(out).toContain("filesystem denyRead: (none)");
  expect(out).toContain("--permission-mode:  (default)");
});

test("formatLaunchPlan strips terminal control sequences so a crafted name can't forge the plan", () => {
  // A repo name carrying ANSI cursor-up + erase-line could overwrite the rendered settings.
  const out = plan({ repo: "me/\x1b[2K\x1b[1Aevil", worktree: "/wt/\x07bell" });
  expect(out).not.toContain("\x1b"); // no ESC byte survives
  expect(out).not.toContain("\x07"); // no BEL byte survives
  expect(out).toContain("repo:        me/evil"); // ESC sequences fully consumed, printable text remains
  expect(out).toContain("worktree:    /wt/bell");
});

// ---- runtime selection (pure) ----

test("resolveDevRuntime defaults to claude-code when no runtime flag is passed", () => {
  expect(resolveDevRuntime({})).toBe("claude-code");
});

test("resolveDevRuntime keeps claude-code for an explicit --claude-code", () => {
  expect(resolveDevRuntime({ claudeCode: true })).toBe("claude-code");
});

test("resolveDevRuntime selects codex for --codex", () => {
  expect(resolveDevRuntime({ codex: true })).toBe("codex");
});

test("resolveDevRuntime rejects --claude-code together with --codex", () => {
  expect(() => resolveDevRuntime({ claudeCode: true, codex: true })).toThrow(
    /mutually exclusive/,
  );
});

test("resolveDevRuntime uses defaultRuntime when no flag is passed (#516)", () => {
  expect(resolveDevRuntime({ defaultRuntime: "codex" })).toBe("codex");
  expect(resolveDevRuntime({ defaultRuntime: "claude-code" })).toBe(
    "claude-code",
  );
});

test("resolveDevRuntime prefers an explicit flag over defaultRuntime (#516)", () => {
  expect(resolveDevRuntime({ claudeCode: true, defaultRuntime: "codex" })).toBe(
    "claude-code",
  );
  expect(
    resolveDevRuntime({ codex: true, defaultRuntime: "claude-code" }),
  ).toBe("codex");
});

test("resolveDevRuntime selects grok for --grok", () => {
  expect(resolveDevRuntime({ grok: true })).toBe("grok");
  expect(resolveDevRuntime({ defaultRuntime: "grok" })).toBe("grok");
  expect(resolveDevRuntime({ grok: true, defaultRuntime: "codex" })).toBe(
    "grok",
  );
});

test("resolveDevRuntime rejects grok combined with another runtime flag", () => {
  expect(() => resolveDevRuntime({ grok: true, codex: true })).toThrow(
    /mutually exclusive/,
  );
  expect(() => resolveDevRuntime({ grok: true, claudeCode: true })).toThrow(
    /mutually exclusive/,
  );
  expect(() =>
    resolveDevRuntime({ grok: true, codex: true, claudeCode: true }),
  ).toThrow(/mutually exclusive/);
});

test("buildCodexArgs grants LOOPHUB_HOME as a sandbox writable root before the prompt", () => {
  expect(
    buildCodexArgs({
      slashCommand: "/lh-build 42",
      loopHubHome: "/tmp/lh-home",
    }),
  ).toEqual([
    "--sandbox",
    "workspace-write",
    "-c",
    'sandbox_workspace_write.writable_roots=["/tmp/lh-home"]',
    "/lh-build 42",
  ]);
});

test("buildCodexArgs JSON-escapes the writable LOOPHUB_HOME path", () => {
  expect(
    buildCodexArgs({
      slashCommand: "/lh-build 42",
      loopHubHome: '/tmp/lh home/quote"dir',
    }),
  ).toContain(
    'sandbox_workspace_write.writable_roots=["/tmp/lh home/quote\\"dir"]',
  );
});

test("buildCodexArgs uses the effective LOOPHUB_HOME by default", () => {
  const previous = process.env.LOOPHUB_HOME;
  process.env.LOOPHUB_HOME = "/tmp/lh-env-home";
  try {
    expect(buildCodexArgs({ slashCommand: "/lh-build 42" })).toContain(
      'sandbox_workspace_write.writable_roots=["/tmp/lh-env-home"]',
    );
  } finally {
    if (previous === undefined) delete process.env.LOOPHUB_HOME;
    else process.env.LOOPHUB_HOME = previous;
  }
});

test("buildCodexArgs adds --dangerously-bypass-approvals-and-sandbox when auto is set", () => {
  expect(
    buildCodexArgs({
      slashCommand: "/lh-build 42",
      auto: true,
      loopHubHome: "/tmp/lh-home",
    }),
  ).toEqual(["--dangerously-bypass-approvals-and-sandbox", "/lh-build 42"]);
});

test("buildCodexArgs passes --model through verbatim and keeps the slash command last (#594)", () => {
  const args = buildCodexArgs({
    slashCommand: "/lh-build 42",
    model: "gpt-5.5",
    loopHubHome: "/tmp/lh-home",
  });
  expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
  expect(args[args.length - 1]).toBe("/lh-build 42");
});

test("buildCodexArgs omits --model when not provided (backend default model) (#594)", () => {
  const args = buildCodexArgs({
    slashCommand: "/lh-build 42",
    loopHubHome: "/tmp/lh-home",
  });
  expect(args.indexOf("--model")).toBe(-1);
});

test("buildCodexArgs strips control characters from the model before argv (#594)", () => {
  const args = buildCodexArgs({
    slashCommand: "/lh-build 42",
    model: "\x1b]0;x\x07gpt-5.5\r",
    loopHubHome: "/tmp/lh-home",
  });
  expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
});

test("buildRuntimeLaunch returns claude and Claude argv for claude-code", () => {
  const launch = buildRuntimeLaunch({
    runtime: "claude-code",
    sessionId: "sid-1",
    slashCommand: "/lh-issue-create",
    sessionName: "New issue (jugyo/loophub)",
  });

  expect(launch.bin).toBe("claude");
  expect(launch.args).toEqual(
    buildClaudeArgs({
      sessionId: "sid-1",
      slashCommand: "/lh-issue-create",
      sessionName: "New issue (jugyo/loophub)",
    }),
  );
  expect(formatSpawnCommand(launch.args, { bin: launch.bin })).toMatch(
    /^claude /,
  );
});

test("buildRuntimeLaunch returns codex and Codex argv for codex", () => {
  const launch = buildRuntimeLaunch({
    runtime: "codex",
    sessionId: "sid-1",
    slashCommand: "/lh-issue-create",
    sessionName: "New issue (jugyo/loophub)",
  });

  expect(launch.bin).toBe("codex");
  expect(launch.args).toEqual(
    buildCodexArgs({ slashCommand: "/lh-issue-create" }),
  );
  expect(formatSpawnCommand(launch.args, { bin: launch.bin })).toContain(
    "'sandbox_workspace_write.writable_roots=",
  );
});

test("buildGrokArgs keeps the slash command last and omits --model / auto flags by default", () => {
  expect(buildGrokArgs({ slashCommand: "/lh-build 42" })).toEqual([
    "/lh-build 42",
  ]);
});

test("buildGrokArgs adds the auto-bypass flag before the prompt when auto is set", () => {
  expect(buildGrokArgs({ slashCommand: "/lh-build 42", auto: true })).toEqual([
    "--force",
    "/lh-build 42",
  ]);
});

test("buildGrokArgs passes --model through verbatim and keeps the slash command last", () => {
  const args = buildGrokArgs({
    slashCommand: "/lh-build 42",
    model: "grok-code-fast-1",
  });
  expect(args[args.indexOf("--model") + 1]).toBe("grok-code-fast-1");
  expect(args[args.length - 1]).toBe("/lh-build 42");
});

test("buildGrokArgs strips control characters from the model before argv", () => {
  const args = buildGrokArgs({
    slashCommand: "/lh-build 42",
    model: "\x1b]0;x\x07grok-4\r",
  });
  expect(args[args.indexOf("--model") + 1]).toBe("grok-4");
});

test("buildRuntimeLaunch returns grok and Grok argv for grok", () => {
  const launch = buildRuntimeLaunch({
    runtime: "grok",
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
    sessionName: "#7 fix it",
    model: "grok-code-fast-1",
    auto: true,
  });

  expect(launch.bin).toBe("grok");
  expect(launch.args).toEqual(
    buildGrokArgs({
      slashCommand: "/lh-build 42",
      model: "grok-code-fast-1",
      auto: true,
    }),
  );
  expect(formatSpawnCommand(launch.args, { bin: launch.bin })).toMatch(
    /^grok /,
  );
});

// ---- spawn command line (pure) ----

test("formatSpawnCommand renders the exact argv as a shell-pasteable `claude` line", () => {
  const args = ["--permission-mode", "auto", "--name", "#42 fix it"];
  // No color: plain text, every arg single-quoted so it survives copy-paste verbatim.
  expect(formatSpawnCommand(args)).toBe(
    "claude '--permission-mode' 'auto' '--name' '#42 fix it'",
  );
});

test("formatSpawnCommand shell-escapes embedded single quotes", () => {
  expect(formatSpawnCommand(["it's"])).toBe("claude 'it'\\''s'");
});

test("formatSpawnCommand renders the codex binary when bin is given", () => {
  const args = buildCodexArgs({
    slashCommand: "/lh-build 42",
    loopHubHome: "/tmp/lh-home",
  });
  expect(formatSpawnCommand(args, { bin: "codex" })).toBe(
    "codex '--sandbox' 'workspace-write' '-c' 'sandbox_workspace_write.writable_roots=[\"/tmp/lh-home\"]' '/lh-build 42'",
  );
});

test("formatSpawnCommand wraps the line in ANSI dim only when color is requested", () => {
  const args = ["--name", "x"];
  const plain = formatSpawnCommand(args, { color: false });
  const dim = formatSpawnCommand(args, { color: true });
  expect(plain).not.toContain("\x1b"); // non-TTY: no escape bytes
  expect(dim).toBe(`\x1b[2m${plain}\x1b[0m`); // TTY: dim wrapper around the same line
});

test("formatSpawnCommand matches the argv handed to spawnSync (single source of truth)", () => {
  // Reuse buildClaudeArgs — the very array passed to spawnSync("claude", claudeArgs) — so the
  // displayed command is provably what runs.
  const { json } = buildManagedSettings({
    repo: "me/proj",
    allow: "example.com",
  });
  const claudeArgs = buildClaudeArgs({
    sessionId: "sid-1",
    managedSettings: json,
    slashCommand: "/lh-build 42",
    sessionName: "#42 title",
  });
  const line = formatSpawnCommand(claudeArgs);
  expect(line).toBe(
    `claude ${claudeArgs.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`,
  );
});

test("formatLaunchPlan handles --permission-mode flag with no value (defensive)", () => {
  const { json } = buildManagedSettings({ repo: "me/proj" });
  // Edge case: claudeArgs ends with --permission-mode and no value (buildClaudeArgs never does this, but formatLaunchPlan is pure).
  const out = formatLaunchPlan({
    repo: "me/proj",
    worktree: "/wt",
    sessionId: "sid",
    slashCommand: "/lh-build 1",
    managedSettings: json,
    claudeArgs: ["--session-id", "sid", "--permission-mode"], // flag, no value
  });
  expect(out).toContain("--permission-mode:  (default)");
});

// ---- launch summary (pure, default/minimal output) ----

test("formatLaunchSummary shows only the basic context (repo / worktree / branch / session-id)", () => {
  const out = formatLaunchSummary({
    repo: "me/proj",
    worktree: "/root/me/proj/issue-42",
    branch: "loophub/issue-42",
    sessionId: "sid-1",
  });
  expect(out).toContain("repo:        me/proj");
  expect(out).toContain("worktree:    /root/me/proj/issue-42");
  expect(out).toContain("branch:      loophub/issue-42");
  expect(out).toContain("session-id:  sid-1");
  // The minimal summary omits the sandbox / managed-settings details (those are --verbose only).
  expect(out).not.toContain("sandbox");
  expect(out).not.toContain("network domains");
  expect(out).not.toContain("denyRead");
});

test("formatLaunchSummary strips terminal control sequences so a crafted value can't forge it", () => {
  const out = formatLaunchSummary({
    repo: "me/\x1b[2K\x1b[1Aevil",
    worktree: "/wt/\x07bell",
    branch: "loophub/issue-1",
    sessionId: "sid",
  });
  expect(out).not.toContain("\x1b");
  expect(out).not.toContain("\x07");
  expect(out).toContain("repo:        me/evil");
  expect(out).toContain("worktree:    /wt/bell");
});

// ---- worktree naming (pure) ----

test("worktree path and branch are deterministic from the PR number (#463)", () => {
  expect(worktreeBranch(42)).toBe("loophub/pr-42");
  expect(worktreePath("/root", "me/loophub", 42)).toBe(
    "/root/me/loophub/pr-42",
  );
});

test("worktreePath rejects repo names that would traverse out of the root", () => {
  expect(() => worktreePath("/root", "../../etc", 1)).toThrow(
    /invalid repo name/,
  );
  expect(() => worktreePath("/root", "..", 1)).toThrow(/invalid repo name/);
  expect(() => worktreePath("/root", "me//proj", 1)).toThrow(
    /invalid repo name/,
  );
});

test("validateExistingLocalBranch accepts existing branches and rejects unsafe refs", async () => {
  const repo = await makeRepo();
  await git(repo, ["branch", "integration/stack"]);

  await expect(
    validateExistingLocalBranch(repo, "integration/stack", "PR base ref"),
  ).resolves.toBeUndefined();
  await expect(
    validateExistingLocalBranch(repo, "missing/stack", "PR base ref"),
  ).rejects.toThrow(/PR base ref must name an existing local branch/);
  await expect(
    validateExistingLocalBranch(repo, "--output=/tmp/lh-base", "PR base ref"),
  ).rejects.toThrow(/PR base ref must be a local branch name/);
  await expect(
    validateExistingLocalBranch(repo, "main~0", "PR base ref"),
  ).rejects.toThrow(/PR base ref must name an existing local branch/);

  rmSync(repo, { recursive: true, force: true });
});

test("legacy worktree path and branch are deterministic from the issue number (pre-#463)", () => {
  expect(legacyWorktreeBranch(42)).toBe("loophub/issue-42");
  expect(legacyWorktreePath("/root", "me/loophub", 42)).toBe(
    "/root/me/loophub/issue-42",
  );
});

// ---- worktree provisioning ----

async function makeRepo(): Promise<string> {
  const p = mkdtempSync(join(tmpdir(), "lh-build-wt-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "f.txt"), "base\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);
  return p;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "lh-build-root-"));
}

function provision(
  repo: string,
  root: string,
  pr: number,
  headRef: string | null = null,
  scheme?: "pr" | "legacy-issue",
  allowCreatingConventionBranch?: boolean,
  defaultBranch = "main",
  baseSha?: string,
) {
  return provisionWorktree({
    repoPath: repo,
    fullName: "me/proj",
    defaultBranch,
    worktreeRoot: root,
    pr,
    scheme,
    headRef,
    allowCreatingConventionBranch,
    baseSha,
  });
}

test("creates a new loophub/pr-<n> branch worktree off the default branch (#463)", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  expect(path).toBe(join(root, "me/proj", "pr-7"));
  expect(existsSync(join(path, "f.txt"))).toBe(true);
  const wt = (await worktreeList(repo)).find((w) => w.path.endsWith("pr-7"));
  expect(wt?.branch).toBe("loophub/pr-7");
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("reuses an existing worktree at the deterministic path", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const a = await provision(repo, root, 7);
  const b = await provision(repo, root, 7);
  expect(b).toBe(a);
  expect(
    (await worktreeList(repo)).filter((w) => w.path.endsWith("pr-7")),
  ).toHaveLength(1);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("re-attaches an existing branch whose worktree was removed (disk-truth self-heal)", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  await git(repo, ["worktree", "remove", "--force", path]);
  expect(existsSync(path)).toBe(false);
  expect(await branchExists(repo, "loophub/pr-7")).toBe(true);
  const again = await provision(repo, root, 7);
  expect(again).toBe(path);
  expect(
    (await worktreeList(repo)).some((w) => w.branch === "loophub/pr-7"),
  ).toBe(true);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("checks out an existing off-convention head branch for a PR without creating a branch", async () => {
  const repo = await makeRepo();
  await git(repo, ["branch", "feature-x"]);
  const root = tmpRoot();
  const _path = await provision(repo, root, 9, "feature-x");
  const wt = (await worktreeList(repo)).find((w) => w.path.endsWith("pr-9"));
  expect(wt?.branch).toBe("feature-x");
  expect(await branchExists(repo, "loophub/pr-9")).toBe(false);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("creates the convention branch fresh when allowCreatingConventionBranch is set and it doesn't exist yet (#463: PR opened before its worktree)", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  // dev.openPr records head_ref = loophub/pr-<n> before the branch/worktree are provisioned;
  // `lh build` then passes that same headRef in here (with allowCreatingConventionBranch, since
  // this is an issue target's own just-resolved PR) — it must be created, not rejected.
  const path = await provision(
    repo,
    root,
    11,
    "loophub/pr-11",
    undefined,
    true,
  );
  expect(path).toBe(join(root, "me/proj", "pr-11"));
  const wt = (await worktreeList(repo)).find((w) => w.path.endsWith("pr-11"));
  expect(wt?.branch).toBe("loophub/pr-11");
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("resumes a pre-created zero-commit draft attempt by creating its missing convention branch (#1187)", async () => {
  const repo = await makeRepo();
  const baseSha = (await git(repo, ["rev-parse", "main"])).stdout.trim();
  const root = tmpRoot();
  const allowCreatingConventionBranch = shouldCreateMissingConventionBranch({
    issueAttempt: { created: false },
    headPendingCreation: true,
    baseSha,
  });

  const path = await provision(
    repo,
    root,
    1185,
    "loophub/pr-1185",
    undefined,
    allowCreatingConventionBranch,
    "main",
    baseSha,
  );

  expect(allowCreatingConventionBranch).toBe(true);
  expect((await git(path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseSha);
  expect(await branchExists(repo, "loophub/pr-1185")).toBe(true);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("does not recreate missing convention branches without durable pending state and a fork point", () => {
  expect(
    shouldCreateMissingConventionBranch({
      issueAttempt: { created: false },
      headPendingCreation: false,
      baseSha: "base-sha",
    }),
  ).toBe(false);
  expect(
    shouldCreateMissingConventionBranch({
      issueAttempt: null,
      headPendingCreation: true,
      baseSha: "base-sha",
    }),
  ).toBe(false);
  expect(
    shouldCreateMissingConventionBranch({
      issueAttempt: { created: false },
      headPendingCreation: true,
      baseSha: null,
    }),
  ).toBe(false);
});

test("creates a fresh convention branch from the supplied PR base branch", async () => {
  const repo = await makeRepo();
  await git(repo, ["checkout", "-q", "-b", "integration/stack"]);
  writeFileSync(join(repo, "f.txt"), "integration\n");
  await git(repo, ["commit", "-qam", "integration base"]);
  await git(repo, ["checkout", "-q", "main"]);
  const root = tmpRoot();

  const path = await provision(
    repo,
    root,
    12,
    "loophub/pr-12",
    undefined,
    true,
    "integration/stack",
  );

  expect(readFileSync(join(path, "f.txt"), "utf8")).toBe("integration\n");
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("creates a fresh convention branch from a recorded base SHA after the base branch advances", async () => {
  const repo = await makeRepo();
  const baseSha = (await git(repo, ["rev-parse", "main"])).stdout.trim();
  writeFileSync(join(repo, "later.txt"), "later\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "advance main"]);
  const root = tmpRoot();

  const path = await provision(
    repo,
    root,
    13,
    "loophub/pr-13",
    undefined,
    true,
    "main",
    baseSha,
  );

  expect((await git(path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseSha);
  expect(existsSync(join(path, "later.txt"))).toBe(false);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("errors when an explicit off-convention headRef does not exist (nothing to fabricate)", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  await expect(
    provision(repo, root, 9, "feature-does-not-exist"),
  ).rejects.toThrow(/branch "feature-does-not-exist" does not exist/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("refuses to fabricate the convention branch when allowCreatingConventionBranch is not set (#463: a direct PR target's branch must not be silently recreated)", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  // headRef matches the PR-id convention but the branch was never created (or was deleted
  // out-of-band) and the caller has not asserted this is a brand-new PR's own branch — a direct
  // `lh build <pr>` re-entering an established PR must refuse rather than silently start on a
  // fresh, empty branch under the same name.
  await expect(provision(repo, root, 11, "loophub/pr-11")).rejects.toThrow(
    /branch "loophub\/pr-11" does not exist/,
  );
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("provisions at the legacy issue-<n> path/branch under scheme legacy-issue", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const path = await provision(repo, root, 7, null, "legacy-issue");
  expect(path).toBe(join(root, "me/proj", "issue-7"));
  const wt = (await worktreeList(repo)).find((w) => w.path.endsWith("issue-7"));
  expect(wt?.branch).toBe("loophub/issue-7");
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("copies the primary checkout's untracked .claude/ into a fresh worktree", async () => {
  const repo = await makeRepo();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude/settings.json"), `{"permissions":{}}`);
  writeFileSync(join(repo, ".claude/settings.local.json"), `{"local":true}`);
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  // .claude/ is untracked, absent from the committed tree the worktree is built from,
  // so its presence here proves the post-provision copy ran.
  expect(existsSync(join(path, ".claude/settings.json"))).toBe(true);
  expect(existsSync(join(path, ".claude/settings.local.json"))).toBe(true);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("re-syncs .claude/ on worktree reuse, picking up the latest content", async () => {
  const repo = await makeRepo();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude/settings.json"), `{"v":1}`);
  const root = tmpRoot();
  const a = await provision(repo, root, 7);
  expect(readFileSync(join(a, ".claude/settings.json"), "utf8")).toBe(
    `{"v":1}`,
  );
  // Mutate the primary, re-provision (idempotent reuse path), expect the copy refreshed.
  writeFileSync(join(repo, ".claude/settings.json"), `{"v":2}`);
  const b = await provision(repo, root, 7);
  expect(b).toBe(a);
  expect(readFileSync(join(b, ".claude/settings.json"), "utf8")).toBe(
    `{"v":2}`,
  );
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("skips the .claude/ copy without error when the primary has none", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  expect(existsSync(join(path, ".claude"))).toBe(false);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// ---- sandbox write-allow sufficiency + confinement (issue #28) ----
//
// A linked worktree's commit writes into the shared common dir and the per-worktree gitdir.
// This proves the *minimal* allow-list is both sufficient and tight: (a) every path a real
// `git add` + `git commit` writes is covered by the allow-list and not carved out by deny,
// (b) the list does not grant the whole gitdir, and (c) other refs (`main`), hooks, config
// and per-worktree config.worktree are not net-writable.
function walkFiles(
  dir: string,
  mtimes = new Map<string, number>(),
): Map<string, number> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, mtimes);
    else if (e.isFile()) mtimes.set(p, statSync(p).mtimeMs);
  }
  return mtimes;
}

function isWithin(child: string, parent: string): boolean {
  // Lexical containment (paths may not exist, e.g. transient lock files), realpath'd when possible.
  const c = existsSync(child) ? realpathSync(child) : child;
  const root = existsSync(parent) ? realpathSync(parent) : parent;
  return c === root || c.startsWith(root + sep);
}

function netWritable(p: string, allow: string[], deny: string[] = []): boolean {
  return allow.some((a) => isWithin(p, a)) && !deny.some((d) => isWithin(p, d));
}

test("worktree commit writes are all covered by the minimal allow-list, which excludes main/hooks/config", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const worktree = await provision(repo, root, 28);

  // The worktree's shared gitdir is the primary checkout's `.git`; the per-worktree dir is its child.
  const gitDir = await gitCommonDir(worktree);
  const worktreeGitDir = await gitDirOf(worktree);
  expect(isWithin(gitDir, join(repo, ".git"))).toBe(true);
  expect(isWithin(worktreeGitDir, gitDir)).toBe(true);
  expect(await gitCommonDir(repo)).toBe(gitDir);

  const { json } = buildManagedSettings({
    repo: "me/proj",
    git: { gitDir, worktreeGitDir, branch: "loophub/pr-28" },
  });
  const fs = JSON.parse(json).sandbox.filesystem;
  const allow: string[] = fs.allowWrite;
  const deny: string[] = fs.denyWrite;

  // Snapshot the gitdir, then make a real commit from inside the worktree.
  const before = walkFiles(gitDir);
  writeFileSync(join(worktree, "f.txt"), "changed\n");
  expect((await git(worktree, ["add", "-A"])).code).toBe(0);
  expect((await git(worktree, ["commit", "-qm", "wt commit"])).code).toBe(0);

  // Every newly written / modified file is net-writable under the allow-list (sufficiency).
  const after = walkFiles(gitDir);
  const written = [...after]
    .filter(([p, m]) => before.get(p) !== m)
    .map(([p]) => p);
  expect(written.length).toBeGreaterThan(0); // the commit really touched the gitdir
  for (const p of written) expect(netWritable(p, allow, deny)).toBe(true);

  // Confinement: the dangerous paths are NOT net-writable.
  expect(netWritable(gitDir, allow, deny)).toBe(false); // not the whole gitdir
  expect(netWritable(join(gitDir, "refs/heads/main"), allow, deny)).toBe(false);
  expect(netWritable(join(gitDir, "hooks/pre-commit"), allow, deny)).toBe(
    false,
  );
  expect(netWritable(join(gitDir, "config"), allow, deny)).toBe(false);
  expect(netWritable(join(gitDir, "packed-refs"), allow, deny)).toBe(false);

  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("refuses to overwrite a path that exists but is not a git worktree", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const occupied = join(root, "me/proj", "pr-7");
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, "stray.txt"), "x");
  await expect(provision(repo, root, 7)).rejects.toThrow(/not a git worktree/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("errors when the default branch cannot be resolved (no commits)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "lh-build-empty-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  const root = tmpRoot();
  await expect(provision(repo, root, 7)).rejects.toThrow(
    /cannot resolve default branch/,
  );
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// ---- CLI arg guards (no DB access before these fail) ----

const CLI = join(import.meta.dirname, "index.ts");
// Full CLI E2E tests start several Node/tsx processes and provision git worktrees, so they need a
// wider budget than Vitest's unit-test-oriented 5s default when the complete suite runs in parallel.
const BUILD_CLI_E2E_TIMEOUT_MS = 20_000;

function cli(
  group: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      group,
      ...args,
    ],
    {
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env,
    },
  );
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

function build(args: string[]) {
  return cli("build", args);
}

test("missing issue number prints usage and exits non-zero", () => {
  const { stderr, exitCode } = build(["--repo", "me/proj"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("usage: lh build");
});

test("non-numeric issue number is rejected", () => {
  const { stderr, exitCode } = build(["foo", "--repo", "me/proj"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("invalid issue id");
});

test("--new-attempt is a boolean flag and does not swallow the issue positional", () => {
  const { stderr, exitCode } = build([
    "--new-attempt",
    "not-a-number",
    "--repo",
    "me/proj",
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("invalid issue id");
});

test("malformed owner/repo/id target is rejected with usage", () => {
  // two segments is neither <id> nor <owner>/<repo>/<id>
  const { stderr, exitCode } = build(["me/proj"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("invalid target");
  expect(stderr).toContain("usage: lh build");
});

test("owner/repo/id with non-numeric id is rejected", () => {
  const { stderr, exitCode } = build(["jugyo/loophub/foo"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("invalid target");
});

test("positional repo conflicting with --repo is a hard error (before DB access)", () => {
  const { stderr, exitCode } = build([
    "jugyo/loophub/42",
    "--repo",
    "other/repo",
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("conflicting repo");
});

test("removed lh dev command no longer reaches the build flow", () => {
  const { stdout, stderr, exitCode } = cli("dev", ["42", "--repo", "me/proj"]);
  expect(exitCode).not.toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("lh build");
  expect(stderr).not.toContain("#42");
});

test(
  "lh build resumes a pre-created zero-commit attempt through Herdr and consumes its branch-creation permission (#1187)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lh-build-e2e-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const herdrLog = join(root, "herdr.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_LOG"
case " $* " in
  *" agent start "*) exit 0 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(join(bin, "herdr"), 0o755);

    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "tester"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    await git(repo, ["add", "base.txt"]);
    await git(repo, ["commit", "-qm", "base"]);
    const baseSha = (await git(repo, ["rev-parse", "main"])).stdout.trim();
    const env = {
      ...process.env,
      LOOPHUB_HOME: home,
      LOOPHUB_DB: join(home, "loophub.db"),
      HERDR_LOG: herdrLog,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };

    expect(
      cli("repo", ["add", repo, "--name", "test/build-e2e"], { env }).exitCode,
    ).toBe(0);
    expect(
      cli(
        "issue",
        [
          "create",
          "--repo",
          "test/build-e2e",
          "--title",
          "zero commit attempt",
        ],
        { env },
      ).exitCode,
    ).toBe(0);
    expect(
      cli(
        "pr",
        [
          "create",
          "--repo",
          "test/build-e2e",
          "--head",
          "loophub/pr-2",
          "--base",
          "main",
          "--title",
          "zero commit attempt",
          "--issue",
          "1",
          "--draft",
        ],
        { env },
      ).exitCode,
    ).toBe(0);
    // Model the workflow/attempt preparer, which creates the PR-number-derived head through
    // dev.openPr and persists this marker before any `lh build` process provisions the branch.
    const db = new DatabaseSync(join(home, "loophub.db"));
    db.prepare(
      `UPDATE pulls SET head_pending_creation = 1
       WHERE issue_id = (SELECT id FROM issues WHERE number = 2)`,
    ).run();
    db.close();

    const first = cli(
      "build",
      [
        "test/build-e2e/1",
        "--herdr",
        "--codex",
        "--model",
        "gpt-5.6-sol",
        "--auto",
      ],
      { env },
    );
    expect(first.exitCode, first.stderr).toBe(0);
    const worktree = join(home, "worktrees", "test", "build-e2e", "pr-2");
    expect((await git(repo, ["rev-parse", "loophub/pr-2"])).stdout.trim()).toBe(
      baseSha,
    );
    expect(readFileSync(herdrLog, "utf8")).toMatch(
      /agent start .*codex .*--model.*gpt-5\.6-sol.*\/lh-build 1/,
    );
    const verifiedDb = new DatabaseSync(join(home, "loophub.db"));
    const persisted = verifiedDb
      .prepare(
        `SELECT head_sha, head_pending_creation
         FROM pulls
        WHERE issue_id = (SELECT id FROM issues WHERE number = 2)`,
      )
      .get() as { head_sha: string; head_pending_creation: number };
    verifiedDb.close();
    expect(persisted).toEqual({
      head_sha: baseSha,
      head_pending_creation: 0,
    });

    await git(repo, ["worktree", "remove", "--force", worktree]);
    await git(repo, ["branch", "-D", "loophub/pr-2"]);
    const second = cli(
      "build",
      [
        "test/build-e2e/1",
        "--herdr",
        "--codex",
        "--model",
        "gpt-5.6-sol",
        "--auto",
      ],
      { env },
    );
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain(
      'branch "loophub/pr-2" does not exist (it should already exist for this PR)',
    );

    rmSync(root, { recursive: true, force: true });
  },
  BUILD_CLI_E2E_TIMEOUT_MS,
);

// ---- dev lock (pure / fs) ----

test("devLockPath is deterministic per (home, repo, PR)", () => {
  expect(devLockPath("/home", "me/proj", 42)).toBe(
    join("/home", "dev-locks", "me", "proj", "pr-42.json"),
  );
});

test("devLockPath rejects repo names that would traverse out of home", () => {
  expect(() => devLockPath("/home", "../../etc", 1)).toThrow(
    /invalid repo name/,
  );
  expect(() => devLockPath("/home", "..", 1)).toThrow(/invalid repo name/);
  expect(() => devLockPath("/home", "me//proj", 1)).toThrow(
    /invalid repo name/,
  );
});

test("pidAlive reports the current process as alive and a free pid as dead", () => {
  expect(pidAlive(process.pid)).toBe(true);
  // PID 0 / negative / non-integer are never valid live targets here.
  expect(pidAlive(0)).toBe(false);
  expect(pidAlive(-1)).toBe(false);
  // A very high pid is almost certainly unused → treated as dead (stale lock).
  expect(pidAlive(2 ** 30)).toBe(false);
});

const sampleLock = (over: Partial<Record<string, unknown>> = {}) => ({
  pid: 999,
  pr: 1,
  worktree: "/wt",
  sessionId: "sid",
  startedAt: "2026-06-25T00:00:00.000Z",
  ...over,
});

test("acquireDevLock claims a free path and round-trips via readDevLock", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-buildlock-"));
  const path = join(dir, "deep", "issue-1.json"); // parent dir does not exist yet
  const lock = sampleLock();
  expect(acquireDevLock(path, lock, () => true)).toEqual({ ok: true }); // creates parent dirs
  expect(readDevLock(path)).toEqual(lock);
  rmSync(dir, { recursive: true, force: true });
});

test("acquireDevLock blocks when a live holder owns the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-buildlock-"));
  const path = join(dir, "issue-1.json");
  const held = sampleLock({ pid: 111 });
  expect(acquireDevLock(path, held, () => true)).toEqual({ ok: true });
  // A second launch with a live holder is refused and the original lock is preserved.
  const res = acquireDevLock(path, sampleLock({ pid: 222 }), () => true);
  expect(res).toEqual({ ok: false, held });
  expect(readDevLock(path)).toEqual(held);
  rmSync(dir, { recursive: true, force: true });
});

test("acquireDevLock reclaims a stale (dead-pid) lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-buildlock-"));
  const path = join(dir, "issue-1.json");
  acquireDevLock(path, sampleLock({ pid: 111 }), () => true);
  const fresh = sampleLock({ pid: 222 });
  expect(acquireDevLock(path, fresh, () => false)).toEqual({ ok: true });
  expect(readDevLock(path)).toEqual(fresh); // holder overwritten
  rmSync(dir, { recursive: true, force: true });
});

test("acquireDevLock reclaims a malformed/partial lock instead of treating it as held", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-buildlock-"));
  const path = join(dir, "issue-1.json");
  writeFileSync(path, JSON.stringify({ pid: 333 })); // partial: only pid, no other fields
  const fresh = sampleLock({ pid: 444 });
  // A live predicate must NOT keep a malformed lock alive — it reads as no-lock and is reclaimed.
  expect(acquireDevLock(path, fresh, () => true)).toEqual({ ok: true });
  expect(readDevLock(path)).toEqual(fresh);
  rmSync(dir, { recursive: true, force: true });
});

test("acquireDevLock with --force overrides a live holder", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-buildlock-"));
  const path = join(dir, "issue-1.json");
  acquireDevLock(path, sampleLock({ pid: 111 }), () => true);
  const fresh = sampleLock({ pid: 222 });
  expect(acquireDevLock(path, fresh, () => true, { force: true })).toEqual({
    ok: true,
  });
  expect(readDevLock(path)).toEqual(fresh);
  rmSync(dir, { recursive: true, force: true });
});

test("readDevLock: missing, malformed, and partial all read as no lock; remove is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-buildlock-"));
  const path = join(dir, "issue-1.json");

  // Missing file → null (no lock).
  expect(readDevLock(join(dir, "nope.json"))).toBeNull();

  // Malformed JSON / wrong shape / partial → null, so a corrupt lock never wedges `lh build`.
  writeFileSync(path, "not json");
  expect(readDevLock(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ no: "pid" }));
  expect(readDevLock(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ pid: 5 })); // pid only, other fields missing
  expect(readDevLock(path)).toBeNull();

  // Remove is idempotent (removing a gone lock does not throw).
  removeDevLock(path);
  expect(existsSync(path)).toBe(false);
  removeDevLock(path);

  rmSync(dir, { recursive: true, force: true });
});
