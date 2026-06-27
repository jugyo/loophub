import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before db.ts runs its import-time setup (see store.test.ts).
const HOME = mkdtempSync(join(tmpdir(), "lh-review-notes-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("./store.ts");
let serialize: typeof import("./serialize.ts");

beforeAll(async () => {
  S = await import("./store.ts");
  serialize = await import("./serialize.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

let seq = 0;
function seedPull() {
  const slug = `notes${seq++}`;
  const repo = S.createRepo(`me/${slug}`, `/tmp/${slug}`);
  const issue = S.createIssue(repo.id, "issue", "feature", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "headsha", issue.id);
  return { repo, issue, pr };
}

test("review note round-trips with its diff range and PR link", () => {
  const { repo, pr } = seedPull();
  const row = S.createReviewNote({
    repoId: repo.id,
    issueId: pr.id,
    baseSha: "base000",
    commitSha: "head111",
    path: "core/app.ts",
    body: "entry point; added auth guard. review: token refresh path",
    author: "bot",
  });
  expect(typeof row.id).toBe("number");
  expect(row.base_sha).toBe("base000");
  expect(row.commit_sha).toBe("head111");

  const got = S.getReviewNoteById(row.id);
  expect(got.path).toBe("core/app.ts");
  expect(got.issue_id).toBe(pr.id);

  // Serializer summarizes the PR by number and exposes the diff range.
  const json = serialize.reviewNoteJSON(got);
  expect(json.pull_request).toEqual({ number: pr.number });
  expect(json.base_sha).toBe("base000");
  expect(json.commit_sha).toBe("head111");
  expect(json.user).toEqual({ login: "bot" });
});

test("multiple notes per file are allowed; list is newest-first", () => {
  const { repo, pr } = seedPull();
  const a = S.createReviewNote({
    repoId: repo.id,
    issueId: pr.id,
    baseSha: "b",
    commitSha: "c",
    path: "same.ts",
    body: "first",
    author: "bot",
  });
  const b = S.createReviewNote({
    repoId: repo.id,
    issueId: pr.id,
    baseSha: "b",
    commitSha: "c",
    path: "same.ts",
    body: "second",
    author: "bot",
  });
  const ids = S.listReviewNotes(pr.id).map((n: any) => n.id);
  expect(ids).toEqual([b.id, a.id]); // newest (higher id) first
});

test("list filters by path and by target commit", () => {
  const { repo, pr } = seedPull();
  S.createReviewNote({
    repoId: repo.id,
    issueId: pr.id,
    baseSha: "b1",
    commitSha: "old",
    path: "x.ts",
    body: "on old commit",
    author: "bot",
  });
  S.createReviewNote({
    repoId: repo.id,
    issueId: pr.id,
    baseSha: "b1",
    commitSha: "new",
    path: "x.ts",
    body: "on new commit",
    author: "bot",
  });
  S.createReviewNote({
    repoId: repo.id,
    issueId: pr.id,
    baseSha: "b1",
    commitSha: "new",
    path: "y.ts",
    body: "other file",
    author: "bot",
  });

  expect(S.listReviewNotes(pr.id, { path: "x.ts" }).length).toBe(2);
  expect(S.listReviewNotes(pr.id, { commitSha: "new" }).length).toBe(2);
  expect(
    S.listReviewNotes(pr.id, { path: "x.ts", commitSha: "new" }).map(
      (n: any) => n.body,
    ),
  ).toEqual(["on new commit"]);
});

test("notes are scoped to their PR", () => {
  const { repo, pr } = seedPull();
  const otherPr = S.createIssue(repo.id, "pull", "feat2", "body", "bot") as any;
  S.createPull(otherPr.id, "feat2", "main", "h2");
  S.createReviewNote({
    repoId: repo.id,
    issueId: pr.id,
    baseSha: "b",
    commitSha: "c",
    path: "f.ts",
    body: "mine",
    author: "bot",
  });
  expect(S.listReviewNotes(otherPr.id).length).toBe(0);
});

test("update edits body and bumps updated_at; delete removes the row", () => {
  const { repo, pr } = seedPull();
  const row = S.createReviewNote({
    repoId: repo.id,
    issueId: pr.id,
    baseSha: "b",
    commitSha: "c",
    path: "f.ts",
    body: "before",
    author: "bot",
  });
  const updated = S.updateReviewNote(row.id, "after");
  expect(updated.body).toBe("after");

  S.deleteReviewNote(row.id);
  expect(S.getReviewNoteById(row.id)).toBeNull();
});
