import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-pull-file-views-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let repoPath: string;
let prNumber: number;
let issueId: number;

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-pull-file-views-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "base.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repoPath, "a.txt"), "a\n");
  writeFileSync(join(repoPath, "b.txt"), "b\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature"]);
  git(["checkout", "-q", "main"]);
  const repo = await svc.repos.create({ path: repoPath, name: "me/views" });
  const pull = await svc.pulls.create("me/views", {
    title: "impl",
    head: "feature",
    base: "main",
  });
  prNumber = pull.number;
  issueId = S.getIssue(repo.id, prNumber)!.id;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("marking a file viewed appends a record and lists it with its sha", () => {
  expect(svc.pullFileViews.list("me/views", prNumber)).toEqual([]);

  const views = svc.pullFileViews.set(
    "me/views",
    prNumber,
    "a.txt",
    "a".repeat(40),
    true,
  );
  expect(views).toEqual([
    { path: "a.txt", sha: "a".repeat(40), viewed_at: expect.any(String) },
  ]);
  expect(svc.pullFileViews.list("me/views", prNumber)).toEqual(views);
});

test("marking the same file again appends rather than replacing the earlier record", () => {
  svc.pullFileViews.set("me/views", prNumber, "b.txt", "b".repeat(40), true);
  svc.pullFileViews.set("me/views", prNumber, "b.txt", "c".repeat(40), true);

  // The newest record is what the screens read...
  expect(
    svc.pullFileViews
      .list("me/views", prNumber)
      .find((view) => view.path === "b.txt")?.sha,
  ).toBe("c".repeat(40));
  // ...and the one it superseded is still in the record.
  expect(
    S.listPullFileViews(issueId)
      .filter((row) => row.path === "b.txt")
      .map((row) => ({ sha: row.sha, viewed: row.viewed })),
  ).toEqual([
    { sha: "b".repeat(40), viewed: 1 },
    { sha: "c".repeat(40), viewed: 1 },
  ]);
});

test("unmarking a file appends a not-viewed record and drops it from the list", () => {
  svc.pullFileViews.set("me/views", prNumber, "a.txt", null, false);

  expect(
    svc.pullFileViews.list("me/views", prNumber).map((view) => view.path),
  ).toEqual(["b.txt"]);
  expect(
    S.listPullFileViews(issueId)
      .filter((row) => row.path === "a.txt")
      .map((row) => row.viewed),
  ).toEqual([1, 0]);
});

test("a file with no last-changed commit is recorded with a null sha", () => {
  svc.pullFileViews.set("me/views", prNumber, "base.txt", null, true);
  expect(
    svc.pullFileViews
      .list("me/views", prNumber)
      .find((view) => view.path === "base.txt"),
  ).toEqual({ path: "base.txt", sha: null, viewed_at: expect.any(String) });
});

test("an unknown pull request is a 404", () => {
  expect(() => svc.pullFileViews.list("me/views", 9999)).toThrow(/not found/i);
  expect(() =>
    svc.pullFileViews.set("me/views", 9999, "a.txt", null, true),
  ).toThrow(/not found/i);
});
