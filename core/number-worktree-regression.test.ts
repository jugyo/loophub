import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { git } from "./git.ts";
import { provisionWorktree } from "./worktree-provision.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-number-worktree-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-number-repo-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("./store.ts");
let svc: typeof import("./service.ts");

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
  await git(REPO_PATH, ["init", "-q", "-b", "main"]);
  await git(REPO_PATH, ["config", "user.email", "t@t.local"]);
  await git(REPO_PATH, ["config", "user.name", "tester"]);
  writeFileSync(join(REPO_PATH, "base.txt"), "base\n");
  await git(REPO_PATH, ["add", "-A"]);
  await git(REPO_PATH, ["commit", "-qm", "base"]);
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

test("deleted PR numbers and their stale worktrees are not reused by a later attempt", async () => {
  const repo = S.createRepo("me/proj", REPO_PATH);
  const baseSha = (await git(REPO_PATH, ["rev-parse", "main"])).stdout.trim();
  const firstIssue = S.createIssue(repo.id, "issue", "first", "", "me");
  S.emitEvent(repo.id, "issue.opened", "me", { number: firstIssue.number });
  const firstPr = S.createIssue(repo.id, "pull", "first attempt", "", "me");
  S.createPull(
    firstPr.id,
    `loophub/pr-${firstPr.number}`,
    "main",
    null,
    firstIssue.id,
    null,
    baseSha,
    true,
  );
  S.emitEvent(repo.id, "pull_request.opened", "me", {
    number: firstPr.number,
  });
  const stalePath = await provisionWorktree({
    repoPath: REPO_PATH,
    fullName: repo.full_name,
    defaultBranch: "main",
    worktreeRoot: join(HOME, "worktrees"),
    pr: firstPr.number,
    headRef: `loophub/pr-${firstPr.number}`,
    allowCreatingConventionBranch: true,
    baseSha,
  });
  writeFileSync(join(stalePath, "stale.txt"), "stale\n");
  await git(stalePath, ["add", "-A"]);
  await git(stalePath, ["commit", "-qm", "stale attempt"]);

  expect(svc.pulls.delete(repo.full_name, firstPr.number)).toEqual({
    ok: true,
  });
  expect(S.getIssue(repo.id, firstPr.number)).toBeNull();
  expect(
    S.listEvents(0, repo.id, 100).some((event) => {
      const payload = JSON.parse(event.payload) as { number?: number };
      return (
        event.type === "pull_request.deleted" &&
        payload.number === firstPr.number
      );
    }),
  ).toBe(true);

  const nextIssue = S.createIssue(repo.id, "issue", "next", "", "me");
  S.emitEvent(repo.id, "issue.opened", "me", { number: nextIssue.number });
  const nextPr = S.createIssue(repo.id, "pull", "next attempt", "", "me");
  S.createPull(
    nextPr.id,
    `loophub/pr-${nextPr.number}`,
    "main",
    null,
    nextIssue.id,
    null,
    baseSha,
    true,
  );
  const nextPath = await provisionWorktree({
    repoPath: REPO_PATH,
    fullName: repo.full_name,
    defaultBranch: "main",
    worktreeRoot: join(HOME, "worktrees"),
    pr: nextPr.number,
    headRef: `loophub/pr-${nextPr.number}`,
    allowCreatingConventionBranch: true,
    baseSha,
  });

  expect([
    firstIssue.number,
    firstPr.number,
    nextIssue.number,
    nextPr.number,
  ]).toEqual([1, 2, 3, 4]);
  expect(nextPath).not.toBe(stalePath);
  expect(existsSync(join(nextPath, "stale.txt"))).toBe(false);
  expect((await git(nextPath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
    baseSha,
  );
});
