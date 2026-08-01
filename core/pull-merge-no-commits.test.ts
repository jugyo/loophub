import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-merge-no-commits-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-merge-no-commits-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  spawnSync("sh", ["-c", `echo x > ${join(repoPath, "a.txt")}`]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("merge() rejects a PR whose head has no commits ahead of base (#691)", async () => {
  // head branch identical to main — the client (`lh pr merge` / the web Merge button) is not the
  // only caller: this guard must hold even if a caller reaches the RPC directly.
  git(["branch", "loophub/empty", "main"]);
  const pr = (await svc.pulls.create(
    "me/proj",
    { title: "no commits", head: "loophub/empty", base: "main" },
    undefined,
  )) as any;

  await expect(
    svc.pulls.merge("me/proj", pr.number, "merge", undefined),
  ).rejects.toThrow("Pull Request has no commits to merge");

  const after = (await svc.pulls.get("me/proj", pr.number)) as any;
  expect(after.merged).toBe(false);
});

test("merge() rejects a PR with commits ahead of base but no effective diff (#1243)", async () => {
  // head branches off main, adds a file, then reverts it: base..head is 2 commits ahead,
  // but base...head has no effective diff — nothing to merge. The two-dot commit count
  // alone would wrongly treat this as mergeable, so the guard must use the three-dot diff.
  git(["branch", "loophub/net-empty", "main"]);
  git(["checkout", "-q", "loophub/net-empty"]);
  spawnSync("sh", ["-c", `echo z > ${join(repoPath, "c.txt")}`]);
  git(["add", "-A"]);
  git(["commit", "-qm", "add c.txt"]);
  spawnSync("rm", [join(repoPath, "c.txt")]);
  git(["add", "-A"]);
  git(["commit", "-qm", "revert c.txt"]);
  git(["checkout", "-q", "main"]);

  const ahead = spawnSync(
    "git",
    ["-C", repoPath, "rev-list", "--count", "main..loophub/net-empty"],
    { encoding: "utf8" },
  ).stdout.trim();
  expect(Number(ahead)).toBeGreaterThanOrEqual(1);

  const pr = (await svc.pulls.create(
    "me/proj",
    { title: "net-empty", head: "loophub/net-empty", base: "main" },
    undefined,
  )) as any;

  await expect(
    svc.pulls.merge("me/proj", pr.number, "merge", undefined),
  ).rejects.toThrow("Pull Request has no commits to merge");

  const after = (await svc.pulls.get("me/proj", pr.number)) as any;
  expect(after.merged).toBe(false);
});

test("merge() succeeds once the head branch has a commit ahead of base", async () => {
  git(["branch", "loophub/one-commit", "main"]);
  git(["checkout", "-q", "loophub/one-commit"]);
  spawnSync("sh", ["-c", `echo y > ${join(repoPath, "b.txt")}`]);
  git(["add", "-A"]);
  git(["commit", "-qm", "impl"]);
  git(["checkout", "-q", "main"]);

  const pr = (await svc.pulls.create(
    "me/proj",
    { title: "has commits", head: "loophub/one-commit", base: "main" },
    undefined,
  )) as any;

  const result = await svc.pulls.merge(
    "me/proj",
    pr.number,
    "merge",
    undefined,
  );
  expect(result.merged).toBe(true);
});

test("merge() rejects a closed PR before publishing another terminal fact", async () => {
  git(["branch", "loophub/closed", "main"]);
  git(["checkout", "-q", "loophub/closed"]);
  spawnSync("sh", ["-c", `echo closed > ${join(repoPath, "closed.txt")}`]);
  git(["add", "-A"]);
  git(["commit", "-qm", "closed PR change"]);
  git(["checkout", "-q", "main"]);

  const pr = (await svc.pulls.create(
    "me/proj",
    { title: "closed", head: "loophub/closed", base: "main" },
    undefined,
  )) as any;
  svc.pulls.update("me/proj", pr.number, { state: "closed" });

  await expect(
    svc.pulls.merge("me/proj", pr.number, "merge", undefined),
  ).rejects.toThrow("Pull Request is not open");
});
