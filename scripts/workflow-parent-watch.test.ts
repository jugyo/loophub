import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

const WATCHER = join(import.meta.dirname, "workflow-parent-watch.sh");
const VALID_ARGS = [
  "--repo",
  "jugyo/loophub",
  "--run",
  "42",
  "--since",
  "7",
  "--herdr-session",
  "session-1",
  "--parent-pane",
  "wS6:p2",
];

let testRoot: string;
let fakeBin: string;

function writeExecutable(name: string, body: string): void {
  const path = join(fakeBin, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function lines(name: string): string[] {
  const path = join(testRoot, name);
  return existsSync(path)
    ? readFileSync(path, "utf8").trimEnd().split("\n")
    : [];
}

function run(args = VALID_ARGS, env: Record<string, string> = {}) {
  return spawnSync(WATCHER, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TEST_ROOT: testRoot,
      ...env,
    },
    timeout: 3_000,
  });
}

function expectStarted(result: ReturnType<typeof run>): void {
  expect(result.error).toBeUndefined();
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "lh-workflow-parent-watch-"));
  fakeBin = join(testRoot, "bin");
  mkdirSync(fakeBin);

  writeExecutable(
    "lh",
    `#!/bin/sh
printf '%s\\n' "$@" >> "$TEST_ROOT/lh-args"
count=0
if [ -f "$TEST_ROOT/lh-count" ]; then count=$(sed -n '1p' "$TEST_ROOT/lh-count"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "$TEST_ROOT/lh-count"
if [ "\${LH_FAIL:-0}" = 1 ]; then echo 'fake lh failed' >&2; exit 23; fi
if [ "$count" -ge "\${LH_NONEMPTY_AFTER:-2}" ]; then printf 'event-row\\n'; fi
`,
  );
  writeExecutable(
    "sleep",
    `#!/bin/sh
printf '%s\\n' "$@" >> "$TEST_ROOT/sleep-args"
if [ "\${SLEEP_FAIL:-0}" = 1 ]; then echo 'fake sleep failed' >&2; exit 24; fi
`,
  );
  writeExecutable(
    "herdr",
    `#!/bin/sh
printf '%s\\n' "$@" >> "$TEST_ROOT/herdr-args"
if [ "\${HERDR_FAIL:-0}" = 1 ]; then echo 'fake herdr failed' >&2; exit 25; fi
`,
  );
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("polls with exact server-side filters, then sends one fixed wake and exits", () => {
  const result = run();

  expectStarted(result);
  expect(result.status).toBe(0);
  const pollArgs = [
    "events",
    "--since",
    "7",
    "--repo",
    "jugyo/loophub",
    "--type",
    "workflow_run",
    "--run",
    "42",
    "--order",
    "asc",
    "--limit",
    "1",
  ];
  expect(lines("lh-args")).toEqual([...pollArgs, ...pollArgs]);
  expect(lines("sleep-args")).toEqual(["1"]);
  expect(lines("herdr-args")).toEqual([
    "--session",
    "session-1",
    "pane",
    "run",
    "wS6:p2",
    "orchestrator: workflow-events-ready",
  ]);
});

test.each([
  ["missing all options", []],
  ["unknown option", [...VALID_ARGS, "--runtime", "codex"]],
  ["duplicate option", [...VALID_ARGS, "--run", "43"]],
  ["missing option value", ["--repo", "--run", "42"]],
  [
    "repo without slash",
    [...VALID_ARGS.slice(0, 1), "loophub", ...VALID_ARGS.slice(2)],
  ],
  [
    "repo with extra slash",
    [...VALID_ARGS.slice(0, 1), "a/b/c", ...VALID_ARGS.slice(2)],
  ],
  [
    "repo with invalid segment",
    [...VALID_ARGS.slice(0, 1), "a/..", ...VALID_ARGS.slice(2)],
  ],
  [
    "repo beginning with hyphen",
    [...VALID_ARGS.slice(0, 1), "-a/b", ...VALID_ARGS.slice(2)],
  ],
  [
    "non-positive run",
    [...VALID_ARGS.slice(0, 3), "0", ...VALID_ARGS.slice(4)],
  ],
  [
    "non-decimal run",
    [...VALID_ARGS.slice(0, 3), "1x", ...VALID_ARGS.slice(4)],
  ],
  [
    "negative cursor",
    [...VALID_ARGS.slice(0, 5), "-1", ...VALID_ARGS.slice(6)],
  ],
  [
    "invalid Herdr session",
    [...VALID_ARGS.slice(0, 7), "bad/session", ...VALID_ARGS.slice(8)],
  ],
  ["invalid parent pane", [...VALID_ARGS.slice(0, 9), "-pane"]],
])("rejects %s before polling", (_name, args) => {
  const result = run(args as string[]);

  expectStarted(result);
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toBe("");
  expect(lines("lh-args")).toEqual([]);
  expect(lines("herdr-args")).toEqual([]);
});

test("surfaces lh failure without sleeping or waking", () => {
  const result = run(VALID_ARGS, { LH_FAIL: "1" });

  expectStarted(result);
  expect(result.status).toBe(23);
  expect(result.stderr).toContain("fake lh failed");
  expect(lines("sleep-args")).toEqual([]);
  expect(lines("herdr-args")).toEqual([]);
});

test("surfaces sleep failure without waking", () => {
  const result = run(VALID_ARGS, { SLEEP_FAIL: "1" });

  expectStarted(result);
  expect(result.status).toBe(24);
  expect(result.stderr).toContain("fake sleep failed");
  expect(lines("herdr-args")).toEqual([]);
});

test("tries Herdr once and surfaces delivery failure", () => {
  const result = run(VALID_ARGS, {
    HERDR_FAIL: "1",
    LH_NONEMPTY_AFTER: "1",
  });

  expectStarted(result);
  expect(result.status).toBe(25);
  expect(result.stderr).toContain("fake herdr failed");
  expect(lines("herdr-args")).toEqual([
    "--session",
    "session-1",
    "pane",
    "run",
    "wS6:p2",
    "orchestrator: workflow-events-ready",
  ]);
});
