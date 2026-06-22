import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, worktreeList, branchExists } from "../core/git.ts";
import {
  buildClaudeArgs,
  buildManagedSettings,
  formatLaunchPlan,
  isAffirmative,
  validateDomain,
  worktreeBranch,
  worktreePath,
  provisionWorktree,
} from "./dev.ts";

// ---- managed settings (pure) ----

test("buildManagedSettings emits a sandboxed config with the default allow-list", () => {
  const { json, allowedDomains } = buildManagedSettings({ repo: "jugyo/local-github" });
  expect(allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
  const s = JSON.parse(json);
  expect(s.sandbox.enabled).toBe(true);
  expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
  expect(s.sandbox.network.allowManagedDomainsOnly).toBe(true);
  expect(s.sandbox.network.allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
});

test("--allow unions validated domains into the proxy allow-list", () => {
  const { allowedDomains } = buildManagedSettings({ repo: "me/proj", allow: "example.com,*.test.dev" });
  expect(allowedDomains).toEqual(["api.anthropic.com", "github.com", "example.com", "*.test.dev"]);
});

test("invalid --allow domain is rejected (injection guard)", () => {
  expect(() => buildManagedSettings({ repo: "me/proj", allow: 'evil",":' })).toThrow(/invalid --allow domain/);
  expect(() => validateDomain('a"b')).toThrow(/invalid --allow domain/);
});

test("invalid --repo is rejected", () => {
  expect(() => buildManagedSettings({ repo: "not-a-repo" })).toThrow(/invalid --repo/);
});

// ---- interactive launch args (pure) ----

test("buildClaudeArgs starts the session in accept-edits mode", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1", managedSettings: "{}", slashCommand: "/loophub-dev 42" });
  // accept-edits is passed explicitly (managed-settings defaultMode does not drive it).
  const i = args.indexOf("--permission-mode");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe("acceptEdits");
});

test("buildClaudeArgs carries session id, managed settings, and the slash command", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1", managedSettings: "{}", slashCommand: "/loophub-dev 42" });
  expect(args[args.indexOf("--session-id") + 1]).toBe("sid-1");
  expect(args[args.indexOf("--managed-settings") + 1]).toBe("{}");
  expect(args[args.length - 1]).toBe("/loophub-dev 42");
});

// ---- launch plan (pure) ----

function plan(overrides: Partial<Parameters<typeof formatLaunchPlan>[0]> = {}) {
  const { json } = buildManagedSettings({ repo: "me/proj", allow: "example.com" });
  const claudeArgs = buildClaudeArgs({ sessionId: "sid-1", managedSettings: json, slashCommand: "/loophub-dev 42" });
  return formatLaunchPlan({
    repo: "me/proj",
    worktree: "/root/me/proj/issue-42",
    sessionId: "sid-1",
    slashCommand: "/loophub-dev 42",
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
  expect(out).toContain("command:     /loophub-dev 42");
});

test("formatLaunchPlan summarizes the managed sandbox settings (not raw JSON)", () => {
  const out = plan();
  expect(out).toContain("sandbox:            enabled (fail if unavailable)");
  expect(out).toContain("unsandboxed cmds:   denied");
  expect(out).toContain("excluded cmds:      gh *");
  expect(out).toContain("network domains:    api.anthropic.com, github.com, example.com (managed only)");
  expect(out).toContain("permissions mode:   acceptEdits");
  expect(out).toContain("filesystem denyRead:");
  expect(out).toContain("- ~/.ssh");
  // readable summary, never a raw one-line JSON blob
  expect(out).not.toContain('{"sandbox"');
});

test("formatLaunchPlan reports the --permission-mode passed on the command line", () => {
  const out = plan();
  expect(out).toContain("--permission-mode:  acceptEdits");
});

test("formatLaunchPlan tolerates missing managed-settings fields without throwing", () => {
  const out = formatLaunchPlan({
    repo: "me/proj",
    worktree: "/wt",
    sessionId: "sid",
    slashCommand: "/loophub-dev 1",
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

test("formatLaunchPlan handles --permission-mode flag with no value (defensive)", () => {
  const { json } = buildManagedSettings({ repo: "me/proj" });
  // Edge case: claudeArgs ends with --permission-mode and no value (buildClaudeArgs never does this, but formatLaunchPlan is pure).
  const out = formatLaunchPlan({
    repo: "me/proj",
    worktree: "/wt",
    sessionId: "sid",
    slashCommand: "/loophub-dev 1",
    managedSettings: json,
    claudeArgs: ["--session-id", "sid", "--permission-mode"], // flag, no value
  });
  expect(out).toContain("--permission-mode:  (default)");
});

// ---- confirm matcher (pure) ----

test("isAffirmative accepts only an explicit yes", () => {
  for (const yes of ["y", "Y", "yes", "YES", " y ", "Yes"]) expect(isAffirmative(yes)).toBe(true);
  for (const no of ["", "n", "no", "nope", "yeah", "ok", "1"]) expect(isAffirmative(no)).toBe(false);
});

// ---- worktree naming (pure) ----

test("worktree path and branch are deterministic from the issue number", () => {
  expect(worktreeBranch(42)).toBe("loophub/issue-42");
  expect(worktreePath("/root", "me/loophub", 42)).toBe("/root/me/loophub/issue-42");
});

test("worktreePath rejects repo names that would traverse out of the root", () => {
  expect(() => worktreePath("/root", "../../etc", 1)).toThrow(/invalid repo name/);
  expect(() => worktreePath("/root", "..", 1)).toThrow(/invalid repo name/);
  expect(() => worktreePath("/root", "me//proj", 1)).toThrow(/invalid repo name/);
});

// ---- worktree provisioning ----

async function makeRepo(): Promise<string> {
  const p = mkdtempSync(join(tmpdir(), "lh-dev-wt-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "f.txt"), "base\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);
  return p;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "lh-dev-root-"));
}

function provision(repo: string, root: string, issue: number, headRef: string | null = null) {
  return provisionWorktree({
    repoPath: repo,
    fullName: "me/proj",
    defaultBranch: "main",
    worktreeRoot: root,
    issue,
    headRef,
  });
}

test("creates a new loophub/issue-<n> branch worktree off the default branch", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  expect(path).toBe(join(root, "me/proj", "issue-7"));
  expect(existsSync(join(path, "f.txt"))).toBe(true);
  const wt = (await worktreeList(repo)).find((w) => w.path.endsWith("issue-7"));
  expect(wt?.branch).toBe("loophub/issue-7");
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("reuses an existing worktree at the deterministic path", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const a = await provision(repo, root, 7);
  const b = await provision(repo, root, 7);
  expect(b).toBe(a);
  expect((await worktreeList(repo)).filter((w) => w.path.endsWith("issue-7"))).toHaveLength(1);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("re-attaches an existing branch whose worktree was removed (disk-truth self-heal)", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const path = await provision(repo, root, 7);
  await git(repo, ["worktree", "remove", "--force", path]);
  expect(existsSync(path)).toBe(false);
  expect(await branchExists(repo, "loophub/issue-7")).toBe(true);
  const again = await provision(repo, root, 7);
  expect(again).toBe(path);
  expect((await worktreeList(repo)).some((w) => w.branch === "loophub/issue-7")).toBe(true);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("checks out an existing head branch for a PR (kind=pull) without creating a branch", async () => {
  const repo = await makeRepo();
  await git(repo, ["branch", "feature-x"]);
  const root = tmpRoot();
  const path = await provision(repo, root, 9, "feature-x");
  const wt = (await worktreeList(repo)).find((w) => w.path.endsWith("issue-9"));
  expect(wt?.branch).toBe("feature-x");
  expect(await branchExists(repo, "loophub/issue-9")).toBe(false);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("refuses to overwrite a path that exists but is not a git worktree", async () => {
  const repo = await makeRepo();
  const root = tmpRoot();
  const occupied = join(root, "me/proj", "issue-7");
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, "stray.txt"), "x");
  await expect(provision(repo, root, 7)).rejects.toThrow(/not a git worktree/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("errors when the default branch cannot be resolved (no commits)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "lh-dev-empty-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  const root = tmpRoot();
  await expect(provision(repo, root, 7)).rejects.toThrow(/cannot resolve default branch/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// ---- CLI arg guards (no DB access before these fail) ----

const CLI = join(import.meta.dirname, "index.ts");

function dev(args: string[]) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", "--import", "tsx", CLI, "dev", ...args],
    { encoding: "utf8" },
  );
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

test("missing issue number prints usage and exits non-zero", () => {
  const { stderr, exitCode } = dev(["--repo", "me/proj"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("usage: lh dev <issue>");
});

test("non-numeric issue number is rejected", () => {
  expect(dev(["foo", "--repo", "me/proj"]).exitCode).not.toBe(0);
});
