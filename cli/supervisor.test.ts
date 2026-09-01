import type * as SqliteNS from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const { Database } = createRequire(import.meta.url)(
  "bun:sqlite",
) as typeof SqliteNS;
const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/supervisor";

let home: string;
let repoPath: string;
let runtimeDir: string;
let runtimeLog: string;

function run(args: string[], input?: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      LOOPHUB_HOME: home,
      LOOPHUB_DB: join(home, "loophub.db"),
      RUNTIME_LOG: runtimeLog,
      PATH: `${runtimeDir}:${process.env.PATH ?? ""}`,
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
}

function stateCounts(): Record<string, number> {
  const db = new Database(join(home, "loophub.db"), { readonly: true });
  try {
    return Object.fromEntries(
      ["issues", "pulls", "agent_sessions", "workflow_runs", "events"].map(
        (table) => [
          table,
          (
            db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
              count: number;
            }
          ).count,
        ],
      ),
    );
  } finally {
    db.close();
  }
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lh-supervisor-home-"));
  repoPath = realpathSync(mkdtempSync(join(tmpdir(), "lh-supervisor-repo-")));
  runtimeDir = mkdtempSync(join(tmpdir(), "lh-supervisor-runtime-"));
  runtimeLog = join(runtimeDir, "runtime.log");

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "README.md"), "test\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "init"]);

  const runtime = `#!/bin/sh
printf 'bin=%s\\n' "$(basename "$0")" > "$RUNTIME_LOG"
printf 'cwd=%s\\n' "$PWD" >> "$RUNTIME_LOG"
previous=
for arg in "$@"; do
  printf 'arg=%s\\n' "$arg" >> "$RUNTIME_LOG"
  if [ "$previous" = "--append-system-prompt-file" ]; then
    cat "$arg" > "$RUNTIME_LOG.contract"
  fi
  previous="$arg"
done
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

test.each([
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
  ["opencode", "opencode"],
])(
  "starts %s in the registered repository without LoopHub state",
  (runtime, bin) => {
    const prompt = `${runtime} supervision prompt`;
    const before = stateCounts();
    const result = run([
      "supervisor",
      "start",
      "--runtime",
      runtime,
      "--prompt",
      prompt,
      "--repo",
      REPO,
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    const log = readFileSync(runtimeLog, "utf8");
    expect(log).toContain(`bin=${bin}`);
    expect(log).toContain(`cwd=${repoPath}`);
    expect(log).toContain(prompt);
    if (runtime === "claude-code") {
      expect(readFileSync(`${runtimeLog}.contract`, "utf8")).toContain(
        "# Supervisor workflow contract",
      );
    } else {
      expect(log).toContain("# Supervisor workflow contract");
    }
    expect(stateCounts()).toEqual(before);
  },
);

test("reads a Supervisor prompt from @path and stdin", () => {
  const path = join(home, "prompt.md");
  writeFileSync(path, "prompt from file\n");
  let result = run([
    "supervisor",
    "start",
    "--runtime",
    "codex",
    "--prompt",
    `@${path}`,
    "--repo",
    REPO,
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(runtimeLog, "utf8")).toContain("prompt from file");

  result = run(
    [
      "supervisor",
      "start",
      "--runtime",
      "grok",
      "--prompt",
      "-",
      "--repo",
      REPO,
    ],
    "prompt from stdin\n",
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(runtimeLog, "utf8")).toContain("prompt from stdin");
});
