import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const CLI = join(import.meta.dirname, "index.ts");

let home: string;
let repo: string;

// `lh skill install` is DB-free; it only needs an isolated HOME and, for project scope, a repo.
function lh(args: string[], cwd: string = home) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      LOOPHUB_HOME: join(home, ".loophub"),
      LOOPHUB_DB: join(home, ".loophub", "loophub.db"),
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

const skillPath = (root: string, dir: string) =>
  join(root, dir, "loophub", "SKILL.md");

// Human output is one installed path per line followed by the summary line (#558).
const installedPaths = (stdout: string) =>
  stdout.trim().split("\n").slice(0, -1);

beforeAll(() => {
  // realpath: macOS resolves /var to /private/var, and the CLI reports the resolved path.
  home = realpathSync(mkdtempSync(join(tmpdir(), "lh-skill-")));
  repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("a target is required: neither --runtime nor --all fails", () => {
  const { stderr, exitCode } = lh(["skill", "install"]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("specify --runtime <id> or --all");
  // Nothing is written, so no runtime's config directory is created by accident.
  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(existsSync(join(home, ".agents"))).toBe(false);
  expect(existsSync(join(home, ".grok"))).toBe(false);
});

test("the configured coding agent is not consulted", () => {
  const loophubHome = join(home, ".loophub");
  mkdirSync(loophubHome, { recursive: true });
  const config = join(loophubHome, "config.json");
  writeFileSync(config, JSON.stringify({ codingAgent: "grok" }));
  try {
    // A configured agent does not become an implicit target...
    expect(lh(["skill", "install"]).exitCode).toBe(1);
    // ...and does not override the named one.
    expect(
      installedPaths(
        lh(["skill", "install", "--runtime", "claude-code"]).stdout,
      ),
    ).toEqual([skillPath(home, ".claude/skills")]);
    expect(existsSync(join(home, ".grok"))).toBe(false);
  } finally {
    rmSync(config, { force: true });
  }
});

test("the human summary names the runtimes without repeating the paths", () => {
  const { stdout, stderr, exitCode } = lh(["skill", "install", "--all"]);
  expect(exitCode).toBe(0);
  const lines = stdout.trim().split("\n");
  expect(installedPaths(stdout)).toHaveLength(3);
  expect(lines.at(-1)).toMatch(
    /^installed the LoopHub skill for claude-code, codex, opencode, opencode2, grok \(user scope, \d+ bytes\)$/,
  );
  // The summary names the runtimes, not the paths, so a terminal does not show each one twice.
  expect(lines.at(-1)).not.toContain("/");
  // Success says nothing on stderr: there it would read as a failure (#558).
  expect(stderr).toBe("");
});

test("--all installs for every runtime, sharing one write per directory", () => {
  const result = JSON.parse(lh(["skill", "install", "--all", "--json"]).stdout);
  expect(result.scope).toBe("user");
  // claude-code, codex/opencode/opencode2 (shared), grok — one write per distinct directory.
  expect(
    result.installs.map((i: { runtimes: string[] }) => i.runtimes),
  ).toEqual([["claude-code"], ["codex", "opencode", "opencode2"], ["grok"]]);
  expect(result.installs.map((i: { path: string }) => i.path)).toEqual([
    skillPath(home, ".claude/skills"),
    skillPath(home, ".agents/skills"),
    skillPath(home, ".grok/skills"),
  ]);
  expect(readFileSync(result.installs[1].path).byteLength).toBe(result.bytes);

  const skill = readFileSync(skillPath(home, ".agents/skills"), "utf8");
  expect(skill).toContain("name: loophub");
  expect(skill).toContain("lh --help");
});

test("--runtime installs for one runtime only", () => {
  const only = realpathSync(mkdtempSync(join(tmpdir(), "lh-skill-one-")));
  try {
    const r = spawnSync(
      process.execPath,
      [CLI, "skill", "install", "--runtime", "codex"],
      {
        cwd: only,
        encoding: "utf8",
        env: { ...process.env, HOME: only },
      },
    );
    expect(r.status ?? 0).toBe(0);
    expect(installedPaths(r.stdout)).toEqual([
      skillPath(only, ".agents/skills"),
    ]);
    expect(existsSync(skillPath(only, ".claude/skills"))).toBe(false);
    expect(existsSync(skillPath(only, ".grok/skills"))).toBe(false);
  } finally {
    rmSync(only, { recursive: true, force: true });
  }
});

// Regression for #556: opencode2 had no skillsDir, so every install that reached it failed with
// `The "paths[1]" property must be of type string, got undefined`.
test("--runtime opencode2 installs into the shared .agents/skills (#556)", () => {
  const { stdout, exitCode } = lh([
    "skill",
    "install",
    "--runtime",
    "opencode2",
  ]);
  expect(exitCode).toBe(0);
  expect(installedPaths(stdout)).toEqual([skillPath(home, ".agents/skills")]);
});

test("re-installing overwrites the existing skill", () => {
  const first = JSON.parse(lh(["skill", "install", "--all", "--json"]).stdout);
  const second = JSON.parse(lh(["skill", "install", "--all", "--json"]).stdout);
  expect(second.installs).toEqual(first.installs);
  expect(readFileSync(second.installs[0].path).byteLength).toBe(second.bytes);
});

test("--scope project writes under the repository root", () => {
  const nested = join(repo, "cli");
  mkdirSync(nested, { recursive: true });
  const { stdout, exitCode } = lh(
    ["skill", "install", "--scope", "project", "--all"],
    nested,
  );
  expect(exitCode).toBe(0);
  // Resolved at the git top level, so a subdirectory installs once per repository.
  expect(installedPaths(stdout)).toEqual([
    skillPath(repo, ".claude/skills"),
    skillPath(repo, ".agents/skills"),
    skillPath(repo, ".grok/skills"),
  ]);
});

test("--scope project outside a git repository fails with a usable message", () => {
  const plain = join(home, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  const { stderr, exitCode } = lh(
    ["skill", "install", "--all", "--scope", "project"],
    plain,
  );
  expect(exitCode).toBe(1);
  expect(stderr).toContain("--scope user");
});

test("an unknown scope or runtime is rejected", () => {
  const scope = lh(["skill", "install", "--all", "--scope", "global"]);
  expect(scope.exitCode).toBe(1);
  expect(scope.stderr).toContain("unknown scope: global");

  const runtime = lh(["skill", "install", "--runtime", "cursor"]);
  expect(runtime.exitCode).toBe(1);
  expect(runtime.stderr).toContain("unknown runtime: cursor");

  const both = lh(["skill", "install", "--runtime", "codex", "--all"]);
  expect(both.exitCode).toBe(1);
  expect(both.stderr).toContain("--runtime and --all cannot be combined");
});

test("--help describes the options and destinations", () => {
  const { stdout, exitCode } = lh(["skill", "install", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("lh skill install (--runtime <id> | --all)");
  expect(stdout).toContain("--scope user|project");
  expect(stdout).toContain("--runtime <id>");
  expect(stdout).toContain("--all");
  expect(stdout).toContain(".agents/skills/loophub/");
});
