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

function sessions(): Array<{
  runtime: string | null;
  model: string | null;
  external_session: string;
}> {
  const db = new DatabaseSync(join(home, "loophub.db"), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT runtime, model, external_session FROM agent_sessions ORDER BY rowid",
      )
      .all() as Array<{
      runtime: string | null;
      model: string | null;
      external_session: string;
    }>;
  } finally {
    db.close();
  }
}

function setRepoAgentOverride(config: {
  override: boolean;
  runtime: string | null;
  model: string | null;
  effort: string | null;
}): void {
  const db = new DatabaseSync(join(home, "loophub.db"));
  try {
    db.prepare(
      `UPDATE repos SET agent_override = ?, agent_runtime = ?, agent_model = ?, agent_effort = ?
       WHERE full_name = ?`,
    ).run(
      config.override ? 1 : 0,
      config.runtime,
      config.model,
      config.effort,
      REPO,
    );
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
  for (const bin of ["claude", "codex", "grok", "opencode"]) {
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
    agents: {
      codex: { defaultModel: "configured-codex-model", defaultEffort: "high" },
    },
  });

  const result = issueNew();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.runtimeLog).toContain("bin=codex");
  expect(result.runtimeLog).toContain("arg=configured-codex-model");
  expect(result.runtimeLog).toContain("arg=model_reasoning_effort=high");
  expect(result.runtimeLog).toContain(
    "arg=Create an AFK-ready LoopHub issue from the user's request, then stop.",
  );
  expect(sessions().at(-1)?.runtime).toBe("codex");
  expect(sessions().at(-1)?.model).toBe("configured-codex-model");
});

test("issue new forwards a direct prompt instead of the default filing prompt", () => {
  const prompt = "Create an issue from the user's request, then stop.";

  const result = issueNew(["--prompt", prompt]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.runtimeLog).toContain(`arg=${prompt}`);
  expect(result.runtimeLog).not.toContain(
    "arg=Create an AFK-ready LoopHub issue from the user's request, then stop.",
  );
});

test("issue new uses the repo Coding agent override over the app defaults (#1534)", () => {
  writeConfig({
    codingAgent: "claude-code",
    agents: {
      "claude-code": { defaultModel: "opus", defaultEffort: "medium" },
      codex: { defaultModel: "gpt-5.5", defaultEffort: "medium" },
    },
  });
  setRepoAgentOverride({
    override: true,
    runtime: "codex",
    model: "gpt-5.6-sol",
    effort: "low",
  });

  const result = issueNew();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.runtimeLog).toContain("bin=codex");
  expect(result.runtimeLog).toContain("arg=gpt-5.6-sol");
  expect(result.runtimeLog).toContain("arg=model_reasoning_effort=low");
  expect(sessions().at(-1)?.runtime).toBe("codex");

  setRepoAgentOverride({
    override: false,
    runtime: null,
    model: null,
    effort: null,
  });
});

test("issue new falls back to app defaults when the repo override is off (#1534)", () => {
  writeConfig({
    codingAgent: "claude-code",
    agents: {
      "claude-code": { defaultModel: "opus", defaultEffort: "xhigh" },
    },
  });
  setRepoAgentOverride({
    override: false,
    runtime: "codex",
    model: "ignored-model",
    effort: "ignored-effort",
  });

  const result = issueNew();

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.runtimeLog).toContain("bin=claude");
  expect(result.runtimeLog).toContain("arg=opus");
  expect(result.runtimeLog).toContain("arg=--effort");
  expect(result.runtimeLog).toContain("arg=xhigh");
  expect(sessions().at(-1)?.runtime).toBe("claude-code");

  setRepoAgentOverride({
    override: false,
    runtime: null,
    model: null,
    effort: null,
  });
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
  ["--opencode", "opencode", "opencode", "claude-code"],
])("issue new forwards %s and --model to the final %s launch boundary", (flag, expectedBin, expectedRuntime, configuredAgent) => {
  writeConfig({ codingAgent: configuredAgent });
  const model = `${expectedRuntime}-custom-model`;

  const result = issueNew([flag, "--model", model, "--effort", "high"]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.runtimeLog).toContain(`bin=${expectedBin}`);
  expect(result.runtimeLog).toContain(`arg=${model}`);
  if (expectedBin === "claude") {
    expect(result.runtimeLog).toContain("arg=--effort");
    expect(result.runtimeLog).toContain("arg=high");
  } else if (expectedBin === "codex") {
    expect(result.runtimeLog).toContain("arg=model_reasoning_effort=high");
  } else if (expectedBin === "opencode") {
    // Interactive TUI rejects --variant (opencode run only); effort must not be forwarded.
    expect(result.runtimeLog).toContain("arg=--auto");
    expect(result.runtimeLog).toContain("arg=--prompt");
    expect(result.runtimeLog).not.toContain("arg=--variant");
    expect(result.runtimeLog).not.toContain("arg=high");
  }
  expect(result.runtimeLog).toContain(
    "arg=Create an AFK-ready LoopHub issue from the user's request, then stop.",
  );
  expect(sessions().at(-1)?.runtime).toBe(expectedRuntime);
  expect(sessions().at(-1)?.model).toBe(model);
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

test("issue new rejects a value-less --effort before registering or spawning", () => {
  const result = invalidIssueNew(["--effort"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--effort requires a value");
  expect(result.runtimeLog).toBe("");
  expect(result.dbCreated).toBe(false);
});

test("issue new rejects the removed Cursor runtime option", () => {
  const result = invalidIssueNew(["--cursor"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--cursor");
  expect(result.stderr).toContain("Cursor coding-agent support was removed");
  expect(result.runtimeLog).toBe("");
  expect(result.dbCreated).toBe(false);
});
