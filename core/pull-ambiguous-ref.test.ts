import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// #12: a stray `$GIT_DIR/<branch-name>` file — git's own ambiguous-ref chain checks it before
// `refs/heads/<name>` — used to shadow a PR's base/head branch, so every git call that took the
// bare name resolved to that file's SHA instead. In the real report `.git/opencode` held an
// unreachable SHA and the whole PR detail page 500'd on `git diff --raw --numstat -z`.
// The repo here reproduces exactly that: base branch `opencode` plus a `.git/opencode` file.

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-ambiguous-ref-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

const SHADOW_SHA = "0".repeat(40); // a well-formed but unreachable object

let svc: typeof import("./service.ts");
let repoPath: string;
let prNumber: number;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-ambiguous-ref-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "README.md"), "# base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  // The PR's base branch, whose name is the one shadowed below.
  git(["branch", "opencode"]);
  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repoPath, "README.md"), "# head\n");
  git(["commit", "-qam", "feature change"]);
  git(["checkout", "-q", "main"]);

  writeFileSync(join(repoPath, ".git", "opencode"), `${SHADOW_SHA}\n`);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  prNumber = (
    await svc.pulls.create("me/proj", {
      title: "the PR",
      body: "changes the readme",
      head: "feature",
      base: "opencode",
    })
  ).number;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("the shadowing pseudo-ref really is ambiguous for git (repro guard)", () => {
  expect(git(["rev-parse", "opencode"]).stdout.trim()).toBe(SHADOW_SHA);
  expect(git(["rev-parse", "refs/heads/opencode"]).stdout.trim()).not.toBe(
    SHADOW_SHA,
  );
});

test("pulls.create records the branch's SHA, not the shadowing pseudo-ref's", () => {
  const baseSha = git(["rev-parse", "refs/heads/opencode"]).stdout.trim();
  expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
  return expect(svc.pulls.baseShaForNumber("me/proj", prNumber)).resolves.toBe(
    baseSha,
  );
});

test("pulls.files diffs the shadowed base branch instead of failing (#12)", async () => {
  const files = await svc.pulls.files("me/proj", prNumber);
  expect(files.map((f) => f.filename)).toEqual(["README.md"]);
  expect(files[0]).toMatchObject({ status: "modified", additions: 1 });
});

test("pulls.get resolves both refs and reports the diff totals (#12)", async () => {
  const pr = await svc.pulls.get("me/proj", prNumber);
  expect(pr.base.sha).toBe(
    git(["rev-parse", "refs/heads/opencode"]).stdout.trim(),
  );
  expect(pr.head.sha).toBe(
    git(["rev-parse", "refs/heads/feature"]).stdout.trim(),
  );
  expect(pr.changed_files).toBe(1);
  expect(pr.commits?.map((c) => c.subject)).toEqual(["feature change"]);
});

test("pulls.fileAtRef reads the shadowed base branch's content (#12)", async () => {
  expect(
    await svc.pulls.fileAtRef("me/proj", prNumber, "README.md", "base"),
  ).toEqual({ status: "ok", content: "# base\n" });
});

test("pulls.merge advances the shadowed base branch (#12)", async () => {
  const headSha = git(["rev-parse", "refs/heads/feature"]).stdout.trim();
  const merged = await svc.pulls.merge("me/proj", prNumber, "squash");
  expect(merged.merged).toBe(true);
  const baseSha = git(["rev-parse", "refs/heads/opencode"]).stdout.trim();
  expect(baseSha).toBe(merged.sha);
  // The squash commit carries the head's tree, so the base branch really moved.
  expect(git(["rev-parse", `${baseSha}^{tree}`]).stdout.trim()).toBe(
    git(["rev-parse", `${headSha}^{tree}`]).stdout.trim(),
  );
});
