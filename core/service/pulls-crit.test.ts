import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isServiceError } from "../errors.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-pulls-crit-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");
let repoPath: string;
let forkSha: string;
let pullNumber: number;

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

beforeAll(async () => {
  svc = await import("../service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-pulls-crit-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "base.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  forkSha = git(["rev-parse", "main"]);

  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repoPath, "feature.txt"), "feature\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  const pull = await svc.pulls.create("me/proj", {
    title: "crit launch",
    head: "feature",
    base: "main",
  });
  pullNumber = pull.number;
});

afterAll(() => {
  // Detach worktrees before deleting the primary checkout.
  spawnSync("git", ["-C", repoPath, "worktree", "prune"], { encoding: "utf8" });
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("critLaunch refuses a PR whose worktree has not been provisioned", async () => {
  await expect(svc.pulls.critLaunch("me/proj", pullNumber)).rejects.toSatisfy(
    (e: unknown) =>
      isServiceError(e) &&
      e.status === 404 &&
      e.message.includes("no worktree") &&
      e.message.includes("does not provision"),
  );
});

test("critLaunch 404s for a missing PR", async () => {
  await expect(svc.pulls.critLaunch("me/proj", 99999)).rejects.toSatisfy(
    (e: unknown) => isServiceError(e) && e.status === 404,
  );
});

test("critLaunch returns worktree path and merge-base range for a provisioned PR", async () => {
  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${pullNumber}`);
  mkdirSync(dirname(worktree), { recursive: true });
  git(["worktree", "add", "-q", worktree, "feature"]);

  const plan = await svc.pulls.critLaunch("me/proj", pullNumber);

  expect(plan.number).toBe(pullNumber);
  expect(plan.worktreePath).toBe(worktree);
  expect(plan.headRef).toBe("feature");
  expect(plan.baseRef).toBe("main");
  expect(plan.rangeBase).toBe(forkSha);
  expect(plan.range).toBe(`${forkSha}..HEAD`);
});
