import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const SESSION_ID = "77777777-0000-0000-0000-000000000001";

let home: string;
let loopHubHome: string;

function lh(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      LOOPHUB_HOME: loopHubHome,
      LOOPHUB_DB: join(loopHubHome, "loophub.db"),
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lh-cli-usage-home-"));
  loopHubHome = join(home, ".loophub");
  const projectDir = join(home, ".claude", "projects", "repo-worktree");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${SESSION_ID}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6-20260601",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 10,
        },
      },
    })}\n`,
  );
  const registered = lh([
    "session",
    "register",
    "--id",
    SESSION_ID,
    "--agent",
    "lh-build",
    "--session",
    SESSION_ID,
    "--runtime",
    "claude-code",
    "--kind",
    "dev",
  ]);
  expect(registered.exitCode).toBe(0);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("usage recalculate syncs from Claude transcript and confirm prints stored usage", () => {
  const synced = lh([
    "session",
    "usage",
    "recalculate",
    "--session",
    SESSION_ID,
    "--json",
  ]);
  expect(synced.exitCode).toBe(0);
  expect(JSON.parse(synced.stdout)).toMatchObject({
    synced: 1,
    sessions: [{ session_id: SESSION_ID, messages: 1 }],
  });

  const confirmed = lh([
    "session",
    "usage",
    "confirm",
    "--session",
    SESSION_ID,
    "--json",
  ]);
  expect(confirmed.exitCode).toBe(0);
  expect(JSON.parse(confirmed.stdout)[0]).toMatchObject({
    session_id: SESSION_ID,
    model: "claude-sonnet-4-6-20260601",
    input_tokens: 100,
    output_tokens: 10,
  });
});
