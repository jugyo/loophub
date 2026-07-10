import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-pull-base-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let D: typeof import("./db.ts");
let S: typeof import("./store.ts");
let svc: typeof import("./service.ts");
let repoPath: string;
let forkSha: string;

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

beforeAll(async () => {
  D = await import("./db.ts");
  S = await import("./store.ts");
  svc = await import("./service.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-pull-base-repo-"));
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
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("PR creation records the fork point independently of the live base ref", async () => {
  const created = await svc.pulls.create("me/proj", {
    title: "record base",
    head: "feature",
    base: "main",
  });
  const repo = S.getRepo("me", "proj")!;
  const issue = S.getIssue(repo.id, created.number)!;

  expect(S.getPull(issue.id)?.base_sha).toBe(forkSha);
  expect(created.base_sha).toBe(forkSha);

  writeFileSync(join(repoPath, "later.txt"), "later\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "advance main"]);
  const currentBaseSha = git(["rev-parse", "main"]);

  const viewed = await svc.pulls.get("me/proj", created.number);
  expect(viewed.base.sha).toBe(currentBaseSha);
  expect(viewed.base_sha).toBe(forkSha);
  expect(await svc.pulls.baseShaForNumber("me/proj", created.number)).toBe(
    forkSha,
  );
});

test("legacy PR reads fall back to the merge base", async () => {
  const repo = S.getRepo("me", "proj")!;
  const issue = S.listPulls(repo.id, "open")[0]!;
  D.db.run("UPDATE pulls SET base_sha = NULL WHERE issue_id = ?", [issue.id]);

  expect(S.getPull(issue.id)?.base_sha).toBeNull();
  expect(await svc.pulls.baseShaForNumber("me/proj", issue.number)).toBe(
    forkSha,
  );
  expect((await svc.pulls.get("me/proj", issue.number)).base_sha).toBe(forkSha);
});
