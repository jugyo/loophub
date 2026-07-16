import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;
const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/issue-new";

let home: string;
let repoPath: string;
let runtimeDir: string;
let runtimeLog: string;

function run(args: string[], runHome = home) {
  const { LOOPHUB_SESSION_ID: _sessionId, ...baseEnv } = process.env;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...baseEnv,
        LOOPHUB_HOME: runHome,
        LOOPHUB_DB: join(runHome, "loophub.db"),
        PATH: `${runtimeDir}:${baseEnv.PATH ?? ""}`,
        RUNTIME_LOG: runtimeLog,
      },
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 0,
  };
}

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
}

function sessions(): Array<{ runtime: string | null }> {
  const db = new DatabaseSync(join(home, "loophub.db"), { readOnly: true });
  try {
    return db
      .prepare("SELECT runtime FROM agent_sessions ORDER BY rowid")
      .all() as Array<{ runtime: string | null }>;
  } finally {
    db.close();
  }
}

function issueNew(args: string[] = []) {
  writeFileSync(runtimeLog, "");
  const result = run(["issue", "new", "--repo", REPO, ...args]);
  return { ...result, runtimeLog: readFileSync(runtimeLog, "utf8") };
}

function invalidIssueNew(args: string[]) {
  const runHome = mkdtempSync(join(tmpdir(), "lh-issue-new-invalid-"));
  try {
    writeFileSync(runtimeLog, "");
    const result = run(["issue", "new", "--repo", REPO, ...args], runHome);
    return {
      ...result,
      runtimeLog: readFileSync(runtimeLog, "utf8"),
      dbCreated: existsSync(join(runHome, "loophub.db")),
    };
  } finally {
    rmSync(runHome, { recursive: true, force: true });
  }
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lh-issue-new-home-"));
  repoPath = mkdtempSync(join(tmpdir(), "lh-issue-new-repo-"));
  runtimeDir = mkdtempSync(join(tmpdir(), "lh-issue-new-runtime-"));
  runtimeLog = join(runtimeDir, "runtime.log");

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "README.md"), "test\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "init"]);

  const runtime = `#!/bin/sh
printf 'bin=%s\\n' "$(basename "$0")" > "$RUNTIME_LOG"
printf 'workspace=%s\\n' "$LOOPHUB_WORKSPACE" >> "$RUNTIME_LOG"
for arg in "$@"; do printf 'arg=%s\\n' "$arg" >> "$RUNTIME_LOG"; done
exit 0
`;
  for (const bin of ["claude", "codex", "grok"]) {
    const path = join(runtimeDir, bin);
    writeFileSync(path, runtime);
    chmodSync(path, 0o755);
  }
  const added = run(["repo", "add", repoPath, "--name", REPO]);
  if (added.exitCode !== 0) throw new Error(added.stderr);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

test("issue new uses the configured default runtime and model", () => {
  writeConfig({
    codingAgent: "codex",
    agents: { codex: { defaultModel: "configured-codex-model" } },
  });

  const result = issueNew();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.runtimeLog).toContain("bin=codex");
  expect(result.runtimeLog).toContain("arg=configured-codex-model");
  expect(result.runtimeLog).toContain("arg=/lh-issue-create");
  expect(sessions().at(-1)?.runtime).toBe("codex");
});

test("issue new carries the target branch into the filing session", () => {
  const result = issueNew(["--target-branch", "workspace/alpha"]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.runtimeLog).toContain("workspace=workspace/alpha");
});

test.each([
  ["--claude-code", "claude", "claude-code", "codex"],
  ["--codex", "codex", "codex", "claude-code"],
  ["--grok", "grok", "grok", "claude-code"],
])("issue new forwards %s and --model to the final %s launch boundary", (flag, expectedBin, expectedRuntime, configuredAgent) => {
  writeConfig({ codingAgent: configuredAgent });
  const model = `${expectedRuntime}-custom-model`;

  const result = issueNew([flag, "--model", model]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.runtimeLog).toContain(`bin=${expectedBin}`);
  expect(result.runtimeLog).toContain(`arg=${model}`);
  expect(result.runtimeLog).toContain("arg=/lh-issue-create");
  expect(sessions().at(-1)?.runtime).toBe(expectedRuntime);
});

test("issue new rejects multiple runtime flags before registering or spawning", () => {
  const result = invalidIssueNew(["--claude-code", "--grok"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("are mutually exclusive");
  expect(result.runtimeLog).toBe("");
  expect(result.dbCreated).toBe(false);
});

test("issue new rejects a value-less --model before registering or spawning", () => {
  const result = invalidIssueNew(["--model"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--model requires a value");
  expect(result.runtimeLog).toBe("");
  expect(result.dbCreated).toBe(false);
});
