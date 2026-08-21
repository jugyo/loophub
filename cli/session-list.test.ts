import type * as SqliteNS from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-session-list-"));
const cli = join(import.meta.dirname, "index.ts");
const { Database } = createRequire(import.meta.url)(
  "bun:sqlite",
) as typeof SqliteNS;

afterAll(() => rmSync(home, { recursive: true, force: true }));

function lh(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOOPHUB_HOME: home,
      LOOPHUB_DB: join(home, "loophub.db"),
    },
  });
}

test("session list only infers Claude Code for historical build agents", () => {
  const reviewerId = "99999999-0000-0000-0000-000000000002";
  const buildId = "99999999-0000-0000-0000-000000000003";
  for (const [id, agent] of [
    [reviewerId, "reviewer"],
    [buildId, "lh-build"],
  ]) {
    const registered = lh([
      "session",
      "register",
      "--id",
      id,
      "--agent",
      agent,
      "--session",
      `external-${id}`,
    ]);
    expect(registered.status, registered.stderr).toBe(0);
  }

  const db = new Database(join(home, "loophub.db"));
  const insertUsage = db.prepare(
    `INSERT INTO session_usage
     (session_id, model, input_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, output_tokens, cost_usd, updated_at)
     VALUES (?, 'legacy', 1, 0, 0, 1, NULL, ?)`,
  );
  for (const id of [reviewerId, buildId]) {
    insertUsage.run(id, new Date().toISOString());
  }
  db.close();

  const listed = lh(["session", "list"]);
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout).toContain(
    `${reviewerId}\treviewer\truntime=unknown\tmodel=default\tsession=external-${reviewerId}`,
  );
  expect(listed.stdout).toContain(
    `${buildId}\tlh-build\truntime=claude-code\tmodel=default\tsession=external-${buildId}`,
  );
});
