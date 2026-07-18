import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-search-migrate-"));
const DB = join(HOME, "legacy.db");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("migration backfills existing issues and pull requests into search", () => {
  const { DatabaseSync } = createRequire(import.meta.url)(
    "node:sqlite",
  ) as typeof SqliteNS;
  const legacy = new DatabaseSync(DB);
  legacy.exec(`
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      local_path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL
    );
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (repo_id, number)
    );
    INSERT INTO repos VALUES
      (1, 'me/legacy', 'legacy', 'me', '/tmp/legacy', 'main', '2026-01-01T00:00:00Z');
    INSERT INTO issues VALUES
      (1, 1, 1, 'issue', 'open', 'Legacy indexed issue', '', 'me',
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      (2, 1, 2, 'pull', 'closed', 'Legacy pull', 'indexed body', 'me',
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  `);
  legacy.close();

  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      "--eval",
      `const { search } = await import("./core/service.ts");
       process.stdout.write(JSON.stringify(search.query("me/legacy", "indexed")));`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOOPHUB_HOME: HOME, LOOPHUB_DB: DB },
      encoding: "utf8",
    },
  );

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  // The title match on the issue outranks the body-only match on the pull, so the issue leads.
  expect(JSON.parse(result.stdout)).toEqual([
    {
      kind: "issue",
      number: 1,
      title: "Legacy indexed issue",
      state: "open",
      snippet: {
        field: "title",
        segments: [
          { text: "Legacy ", match: false },
          { text: "indexed", match: true },
          { text: " issue", match: false },
        ],
      },
    },
    {
      kind: "pull",
      number: 2,
      title: "Legacy pull",
      state: "closed",
      snippet: {
        field: "body",
        segments: [
          { text: "indexed", match: true },
          { text: " body", match: false },
        ],
      },
    },
  ]);
});
