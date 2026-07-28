import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { branchExists, git, worktreeList } from "../core/git.ts";
import {
  acquireDevLock,
  buildClaudeArgs,
  buildCodexArgs,
  buildGrokArgs,
  buildResumeArgs,
  buildRuntimeLaunch,
  devLockPath,
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
  worktreeBranch,
  worktreePath,
} from "./dev.ts";

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

// ---- interactive launch args (pure) ----

test("buildClaudeArgs adds auto mode only when --auto is set", () => {
  // --auto → auto mode, enabled only because the user opted in explicitly.
  const auto = buildClaudeArgs({
    sessionId: "sid-1",
    auto: true,
    slashCommand: "/lh-build 42",
  });
  const i = auto.indexOf("--permission-mode");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(auto[i + 1]).toBe("auto");

  // auto: false (default) → no --permission-mode (Claude's normal approval mode), so an
  // unattended session never auto-edits without an explicit opt-in.
  const off = buildClaudeArgs({
    sessionId: "sid-1",
    auto: false,
    slashCommand: "/lh-build 42",
  });
  expect(off.indexOf("--permission-mode")).toBe(-1);
});

test("buildClaudeArgs carries the session id and the slash command", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
  });
  expect(args[args.indexOf("--session-id") + 1]).toBe("sid-1");
  expect(args[args.length - 1]).toBe("/lh-build 42");
  // No --auto → no auto mode.
  expect(args.indexOf("--permission-mode")).toBe(-1);
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

test("buildCodexArgs passes effort as model_reasoning_effort (#1534)", () => {
  const args = buildCodexArgs({
    slashCommand: "Create an issue.",
    model: "gpt-5.5",
    effort: "high",
    loopHubHome: "/tmp/lh-home",
  });
  expect(args).toContain("model_reasoning_effort=high");
  expect(args[args.length - 1]).toBe("Create an issue.");
});

test("buildClaudeArgs passes --effort through (#1534)", () => {
  const args = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "Create an issue.",
    model: "opus",
    effort: "xhigh",
  });
  expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  expect(args[args.length - 1]).toBe("Create an issue.");
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
    slashCommand: "Create an issue.",
    sessionName: "New issue (jugyo/loophub)",
  });

  expect(launch.bin).toBe("claude");
  expect(launch.args).toEqual(
    buildClaudeArgs({
      sessionId: "sid-1",
      slashCommand: "Create an issue.",
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
    slashCommand: "Create an issue.",
    sessionName: "New issue (jugyo/loophub)",
  });

  expect(launch.bin).toBe("codex");
  expect(launch.args).toEqual(
    buildCodexArgs({ slashCommand: "Create an issue." }),
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
    "--always-approve",
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

test("buildGrokArgs passes --model grok-4.5 when that model is selected", () => {
  const args = buildGrokArgs({
    slashCommand: "/lh-build 42",
    model: "grok-4.5",
  });
  expect(args).toEqual(["--model", "grok-4.5", "/lh-build 42"]);
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
  const claudeArgs = buildClaudeArgs({
    sessionId: "sid-1",
    slashCommand: "/lh-build 42",
    sessionName: "#42 title",
  });
  const line = formatSpawnCommand(claudeArgs);
  expect(line).toBe(
    `claude ${claudeArgs.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`,
  );
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

test("reuses a partial pending worktree while its HEAD still matches the recorded base", async () => {
  const repo = await makeRepo();
  const baseSha = (await git(repo, ["rev-parse", "main"])).stdout.trim();
  const root = tmpRoot();
  const path = await provision(
    repo,
    root,
    1186,
    "loophub/pr-1186",
    undefined,
    true,
    "main",
    baseSha,
  );

  await expect(
    provision(
      repo,
      root,
      1186,
      "loophub/pr-1186",
      undefined,
      true,
      "main",
      baseSha,
    ),
  ).resolves.toBe(path);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("rejects a stale pending worktree whose HEAD differs from the recorded base", async () => {
  const repo = await makeRepo();
  const baseSha = (await git(repo, ["rev-parse", "main"])).stdout.trim();
  const root = tmpRoot();
  const path = await provision(
    repo,
    root,
    1187,
    "loophub/pr-1187",
    undefined,
    true,
    "main",
    baseSha,
  );
  writeFileSync(join(path, "stale.txt"), "stale\n");
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-qm", "stale attempt"]);

  await expect(
    provision(
      repo,
      root,
      1187,
      "loophub/pr-1187",
      undefined,
      true,
      "main",
      baseSha,
    ),
  ).rejects.toThrow(/does not match recorded base/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("rejects a stale pending branch left behind after its worktree is removed", async () => {
  const repo = await makeRepo();
  const baseSha = (await git(repo, ["rev-parse", "main"])).stdout.trim();
  const root = tmpRoot();
  const path = await provision(
    repo,
    root,
    1188,
    "loophub/pr-1188",
    undefined,
    true,
    "main",
    baseSha,
  );
  writeFileSync(join(path, "stale.txt"), "stale\n");
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-qm", "stale attempt"]);
  await git(repo, ["worktree", "remove", "--force", path]);

  await expect(
    provision(
      repo,
      root,
      1188,
      "loophub/pr-1188",
      undefined,
      true,
      "main",
      baseSha,
    ),
  ).rejects.toThrow(/does not match recorded base/);
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

test("copies only the primary checkout's Claude settings into a fresh worktree", async () => {
  const repo = await makeRepo();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude/settings.json"), `{"permissions":{}}`);
  writeFileSync(join(repo, ".claude/settings.local.json"), `{"local":true}`);
  writeFileSync(join(repo, ".claude/commands.md"), "not copied");
  mkdirSync(join(repo, ".claude/worktrees/large/nested"), { recursive: true });
  writeFileSync(
    join(repo, ".claude/worktrees/large/nested/content.txt"),
    "not copied",
  );
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  expect(readFileSync(join(path, ".claude/settings.json"), "utf8")).toBe(
    `{"permissions":{}}`,
  );
  expect(readFileSync(join(path, ".claude/settings.local.json"), "utf8")).toBe(
    `{"local":true}`,
  );
  expect(existsSync(join(path, ".claude/commands.md"))).toBe(false);
  expect(existsSync(join(path, ".claude/worktrees"))).toBe(false);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("re-syncs .claude/ on worktree reuse, picking up the latest content", async () => {
  const repo = await makeRepo();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude/settings.json"), `{"v":1}`);
  writeFileSync(join(repo, ".claude/settings.local.json"), `{"local":1}`);
  const root = tmpRoot();
  const a = await provision(repo, root, 7);
  expect(readFileSync(join(a, ".claude/settings.json"), "utf8")).toBe(
    `{"v":1}`,
  );
  expect(readFileSync(join(a, ".claude/settings.local.json"), "utf8")).toBe(
    `{"local":1}`,
  );
  // Mutate the primary, re-provision (idempotent reuse path), expect the copy refreshed.
  writeFileSync(join(repo, ".claude/settings.json"), `{"v":2}`);
  writeFileSync(join(repo, ".claude/settings.local.json"), `{"local":2}`);
  const b = await provision(repo, root, 7);
  expect(b).toBe(a);
  expect(readFileSync(join(b, ".claude/settings.json"), "utf8")).toBe(
    `{"v":2}`,
  );
  expect(readFileSync(join(b, ".claude/settings.local.json"), "utf8")).toBe(
    `{"local":2}`,
  );
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("skips the Claude settings copy when the primary has no .claude directory", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  expect(existsSync(join(path, ".claude"))).toBe(false);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("skips absent Claude settings without copying other .claude content", async () => {
  const repo = await makeRepo();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude/commands.md"), "not copied");
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  expect(existsSync(join(path, ".claude"))).toBe(false);
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
