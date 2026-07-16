import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-search-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let D: typeof import("./db.ts");
let S: typeof import("./store.ts");
let svc: typeof import("./service.ts");

beforeAll(async () => {
  D = await import("./db.ts");
  S = await import("./store.ts");
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("search queries the persistent index across issue and PR title/body", () => {
  const repo = S.createRepo("me/search", "/tmp/search");
  const otherRepo = S.createRepo("me/other-search", "/tmp/other-search");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Alpha release",
    "ordinary body",
    "me",
  );
  const pull = S.createIssue(
    repo.id,
    "pull",
    "Unrelated title",
    "implements ALPHABET navigation",
    "me",
  );
  S.createPull(pull.id, "alpha", "main", null);
  const closed = S.createIssue(
    repo.id,
    "issue",
    "Closed alphabet task",
    "",
    "me",
  );
  S.updateIssue(closed.id, { state: "closed" });
  S.createIssue(otherRepo.id, "issue", "Alpha elsewhere", "", "me");

  expect(svc.search.query("me/search", "pHa")).toEqual([
    {
      kind: "issue",
      number: closed.number,
      title: "Closed alphabet task",
      state: "closed",
    },
    {
      kind: "pull",
      number: pull.number,
      title: "Unrelated title",
      state: "open",
    },
    {
      kind: "issue",
      number: issue.number,
      title: "Alpha release",
      state: "open",
    },
  ]);
  expect(svc.search.query("me/search", "a")).toHaveLength(3);
  expect(svc.search.query("me/search", "al")).toHaveLength(3);
  expect(svc.search.query("me/search", "missing")).toEqual([]);
  expect(svc.search.query("me/search", "   ")).toEqual([]);
});

test("search index follows title/body updates and deletes", () => {
  const repo = S.createRepo("me/search-sync", "/tmp/search-sync");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Original searchable title",
    "first body",
    "me",
  );

  expect(svc.search.query("me/search-sync", "searchable")).toHaveLength(1);
  S.updateIssue(issue.id, {
    title: "Replacement title",
    body: "second searchable body",
  });
  expect(svc.search.query("me/search-sync", "original")).toEqual([]);
  expect(svc.search.query("me/search-sync", "searchable")).toHaveLength(1);
  expect(svc.search.query("me/search-sync", "s")).toHaveLength(1);
  expect(svc.search.query("me/search-sync", "se")).toHaveLength(1);

  D.db.run("DELETE FROM issues WHERE id = ?", [issue.id]);
  expect(svc.search.query("me/search-sync", "searchable")).toEqual([]);
});

test("search index failures roll back issue creation and updates", () => {
  const repo = S.createRepo("me/search-atomic", "/tmp/search-atomic");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Stable searchable title",
    "",
    "me",
  );
  D.db.exec(`
    CREATE TRIGGER fail_issue_search_insert
    BEFORE INSERT ON issue_search_grams
    WHEN new.gram = 'fai'
    BEGIN
      SELECT RAISE(ABORT, 'forced search index failure');
    END;
  `);

  expect(() =>
    S.createIssue(repo.id, "issue", "Failure on create", "", "me"),
  ).toThrow(/forced search index failure/);
  expect(S.getIssue(repo.id, issue.number + 1)).toBeNull();

  expect(() => S.updateIssue(issue.id, { title: "Failure on update" })).toThrow(
    /forced search index failure/,
  );
  expect(S.getIssueById(issue.id)?.title).toBe("Stable searchable title");
  expect(svc.search.query("me/search-atomic", "stable")).toHaveLength(1);
  expect(svc.search.query("me/search-atomic", "failure")).toEqual([]);

  D.db.exec("DROP TRIGGER fail_issue_search_insert");
});

test("search query plan uses the persistent gram index", () => {
  const plan = D.db
    .query(
      `EXPLAIN QUERY PLAN
       SELECT i.kind, i.number, i.title, i.state
       FROM issue_search_grams search
       JOIN issues i ON i.id = search.issue_id
       WHERE search.gram IN (?) AND i.repo_id = ?
       GROUP BY i.id`,
    )
    .all("ind", 1) as { detail: string }[];

  expect(
    plan.some((row) =>
      /SEARCH search USING COVERING INDEX idx_issue_search_grams_gram_issue/i.test(
        row.detail,
      ),
    ),
  ).toBe(true);
});
