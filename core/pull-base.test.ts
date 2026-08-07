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
let pullBase: typeof import("./pull-base.ts");
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
  pullBase = await import("./pull-base.ts");

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

test("diff base follows the live merge-base after base is merged into head", async () => {
  // Own repo so earlier tests' NULL base_sha / advanced main do not interfere.
  const path = mkdtempSync(join(tmpdir(), "lh-pull-diff-base-"));
  const g = (args: string[]): string => {
    const result = spawnSync("git", ["-C", path, ...args], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(path, "base.txt"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  const localFork = g(["rev-parse", "main"]);
  g(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(path, "feature.txt"), "feature\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "feature"]);
  g(["checkout", "-q", "main"]);

  await svc.repos.create({ path, name: "me/diff-base" });
  const created = await svc.pulls.create("me/diff-base", {
    title: "diff base",
    head: "feature",
    base: "main",
  });
  const repo = S.getRepo("me", "diff-base")!;
  const issue = S.getIssue(repo.id, created.number)!;
  const pull = S.getPull(issue.id)!;

  // Before base moves, fork point and live merge-base agree.
  expect(await pullBase.resolvePullBaseSha(path, pull)).toBe(localFork);
  expect(await pullBase.resolvePullDiffBaseSha(path, pull)).toBe(localFork);

  writeFileSync(join(path, "base-only.txt"), "from base\n");
  g(["checkout", "-q", "main"]);
  g(["add", "-A"]);
  g(["commit", "-qm", "advance main with unrelated file"]);
  const advancedMain = g(["rev-parse", "main"]);

  g(["checkout", "-q", "feature"]);
  g(["merge", "-q", "main", "-m", "merge main into feature"]);

  // Fork point stays fixed; live three-dot base moves to the merged main tip.
  expect(await pullBase.resolvePullBaseSha(path, pull)).toBe(localFork);
  expect(await pullBase.resolvePullDiffBaseSha(path, pull)).toBe(advancedMain);

  rmSync(path, { recursive: true, force: true });
});

// #2420: Agents often merge origin/<base> while the local base branch still lags. The live
// three-dot base must follow the remote tip that is already in head, not the stale local tip.
test("diff base prefers origin/<base> when local base lags after a remote merge", async () => {
  const path = mkdtempSync(join(tmpdir(), "lh-pull-diff-origin-base-"));
  const g = (args: string[]): string => {
    const result = spawnSync("git", ["-C", path, ...args], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(path, "shared.txt"), "shared\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  const localFork = g(["rev-parse", "main"]);
  g(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(path, "feature-only.txt"), "from pr\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "feature"]);
  g(["checkout", "-q", "main"]);

  // Advance only the remote-tracking base; leave local main at the fork.
  writeFileSync(join(path, "base-only.txt"), "from origin main\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "advance origin/main with unrelated file"]);
  const originMain = g(["rev-parse", "main"]);
  g(["update-ref", "refs/remotes/origin/main", originMain]);
  // Hard-reset local main so the working tree matches the stale tip.
  g(["reset", "--hard", localFork]);

  g(["checkout", "-q", "feature"]);
  g([
    "merge",
    "-q",
    "refs/remotes/origin/main",
    "-m",
    "merge origin/main into feature",
  ]);

  await svc.repos.create({ path, name: "me/diff-origin-base" });
  const created = await svc.pulls.create("me/diff-origin-base", {
    title: "origin base lag",
    head: "feature",
    base: "main",
  });
  const repo = S.getRepo("me", "diff-origin-base")!;
  const issue = S.getIssue(repo.id, created.number)!;
  const pull = S.getPull(issue.id)!;

  expect(g(["rev-parse", "main"])).toBe(localFork);
  expect(g(["rev-parse", "refs/remotes/origin/main"])).toBe(originMain);
  expect(await pullBase.resolvePullBaseSha(path, pull)).toBe(localFork);
  expect(await pullBase.resolvePullDiffBaseSha(path, pull)).toBe(originMain);

  rmSync(path, { recursive: true, force: true });
});

// #2444: rebasing the base branch rewrites the commits head forked from, so the live merge-base
// falls back to a commit from before the rewrite. The diff must stay anchored at the recorded
// fork point, which head still contains.
test("diff base keeps the fork point after the base branch is rebased", async () => {
  const path = mkdtempSync(join(tmpdir(), "lh-pull-diff-rebased-base-"));
  const g = (args: string[]): string => {
    const result = spawnSync("git", ["-C", path, ...args], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(path, "shared.txt"), "shared\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "root"]);
  const root = g(["rev-parse", "main"]);
  writeFileSync(join(path, "base-only.txt"), "from base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base work"]);
  const localFork = g(["rev-parse", "main"]);

  g(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(path, "feature-only.txt"), "from pr\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "feature"]);
  g(["checkout", "-q", "main"]);

  await svc.repos.create({ path, name: "me/diff-rebased-base" });
  const created = await svc.pulls.create("me/diff-rebased-base", {
    title: "rebased base",
    head: "feature",
    base: "main",
  });
  const repo = S.getRepo("me", "diff-rebased-base")!;
  const issue = S.getIssue(repo.id, created.number)!;
  const pull = S.getPull(issue.id)!;
  expect(await pullBase.resolvePullDiffBaseSha(path, pull)).toBe(localFork);

  // Rewrite "base work" so main no longer contains the fork point.
  g(["reset", "--hard", "-q", root]);
  writeFileSync(join(path, "base-only.txt"), "from base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base work, rewritten"]);
  expect(g(["merge-base", "main", "feature"])).toBe(root);

  expect(await pullBase.resolvePullBaseSha(path, pull)).toBe(localFork);
  expect(await pullBase.resolvePullDiffBaseSha(path, pull)).toBe(localFork);

  rmSync(path, { recursive: true, force: true });
});

// A head that was itself rebased no longer contains the recorded fork point, so it must not win
// over the live merge-base — diffing from a commit outside head would report base-side changes.
test("diff base ignores a fork point the head branch no longer contains", async () => {
  const path = mkdtempSync(join(tmpdir(), "lh-pull-diff-rebased-head-"));
  const g = (args: string[]): string => {
    const result = spawnSync("git", ["-C", path, ...args], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(path, "shared.txt"), "shared\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "root"]);
  const localFork = g(["rev-parse", "main"]);
  g(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(path, "feature-only.txt"), "from pr\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "feature"]);
  g(["checkout", "-q", "main"]);

  await svc.repos.create({ path, name: "me/diff-rebased-head" });
  const created = await svc.pulls.create("me/diff-rebased-head", {
    title: "rebased head",
    head: "feature",
    base: "main",
  });
  const repo = S.getRepo("me", "diff-rebased-head")!;
  const issue = S.getIssue(repo.id, created.number)!;
  const pull = S.getPull(issue.id)!;

  // Advance main, then rebase feature onto it: the fork point leaves head's history.
  writeFileSync(join(path, "base-only.txt"), "from base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "advance main"]);
  const advancedMain = g(["rev-parse", "main"]);
  g(["checkout", "-q", "feature"]);
  g(["rebase", "-q", "main"]);
  g(["checkout", "-q", "main"]);

  expect(pull.base_sha).toBe(localFork);
  expect(await pullBase.resolvePullDiffBaseSha(path, pull)).toBe(advancedMain);

  rmSync(path, { recursive: true, force: true });
});
