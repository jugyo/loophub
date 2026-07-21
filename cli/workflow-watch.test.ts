import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-workflow-watch-"));
const fakeBin = join(home, "herdr");
const herdrArgs = join(home, "herdr-args");
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "loophub.db");

const VALID_ARGS = [
  "--repo",
  "me/workflow-watch",
  "--run",
  "42",
  "--since",
  "0",
  "--herdr-session",
  "session-1",
  "--parent-pane",
  "wS6:p2",
];

function runWatch(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      "cli/index.ts",
      "workflow",
      "watch",
      ...args,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${home}:${process.env.PATH}`, ...env },
      timeout: 3_000,
    },
  );
}

beforeAll(async () => {
  writeFileSync(
    fakeBin,
    `#!/bin/sh
printf '%s\\n' "$@" > "${herdrArgs}"
if [ "\${HERDR_FAIL:-0}" = 1 ]; then echo 'fake herdr failed' >&2; exit 25; fi
`,
  );
  chmodSync(fakeBin, 0o755);
  const S = await import("../core/store.ts");
  const repo = S.createRepo("me/workflow-watch", process.cwd());
  S.emitEvent(repo.id, "workflow_run.turn_done", "test", { id: 42 });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("lh workflow watch delivers the fixed wake and exits successfully", () => {
  const result = runWatch(VALID_ARGS);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(readFileSync(herdrArgs, "utf8").trimEnd().split("\n")).toEqual([
    "--session",
    "session-1",
    "pane",
    "run",
    "wS6:p2",
    "orchestrator: workflow-events-ready",
  ]);
});

test.each([
  ["missing options", []],
  ["duplicate option", [...VALID_ARGS, "--run", "43"]],
  ["unknown option", [...VALID_ARGS, "--runtime", "codex"]],
  ["invalid run", [...VALID_ARGS.slice(0, 3), "0", ...VALID_ARGS.slice(4)]],
])("lh workflow watch rejects %s with a visible non-zero exit", (_name, args) => {
  const result = runWatch(args);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("workflow watch:");
});

test("lh workflow watch surfaces a Herdr failure without retrying", () => {
  const result = runWatch(VALID_ARGS, { HERDR_FAIL: "1" });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("fake herdr failed");
  expect(result.stderr).toContain(
    "workflow watch: Herdr delivery failed: herdr exited with status 25",
  );
});
