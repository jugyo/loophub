import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-pull-file-at-ref-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-pull-file-at-ref-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "README.md"), "# base\n");
  writeFileSync(join(repoPath, "untouched.md"), "# never changes\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repoPath, "README.md"), "# head\n");
  writeFileSync(join(repoPath, "new.md"), "# added on feature\n");
  git(["add", "-A"]);
  git(["commit", "-qam", "feature change"]);
  git(["checkout", "-q", "main"]);

  git(["checkout", "-q", "-b", "rename-feature"]);
  mkdirSync(join(repoPath, "docs"));
  git(["mv", "README.md", "docs/README.md"]);
  git(["commit", "-qm", "rename readme"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("pulls.fileAtRef resolves base/head refs and reports missing for an added file", async () => {
  const pr = await svc.pulls.create("me/proj", {
    title: "the PR",
    body: "adds a readme",
    head: "feature",
    base: "main",
  });

  expect(
    await svc.pulls.fileAtRef("me/proj", pr.number, "README.md", "base"),
  ).toEqual({
    status: "ok",
    content: "# base\n",
  });
  expect(
    await svc.pulls.fileAtRef("me/proj", pr.number, "README.md", "head"),
  ).toEqual({
    status: "ok",
    content: "# head\n",
  });
  // new.md was added on feature, so it doesn't exist at base.
  expect(
    await svc.pulls.fileAtRef("me/proj", pr.number, "new.md", "base"),
  ).toEqual({
    status: "missing",
  });
});

test("pulls.fileAtRef 404s for a missing PR", async () => {
  await expect(
    svc.pulls.fileAtRef("me/proj", 999, "README.md", "head"),
  ).rejects.toMatchObject({ status: 404 });
});

test("pulls.fileAtRef 404s for a path outside the PR's diff (not a general file-read primitive)", async () => {
  const pr = await svc.pulls.create("me/proj", {
    title: "another PR",
    body: "adds a readme",
    head: "feature",
    base: "main",
  });

  // untouched.md exists in the repo at both base and head, but was never part of this PR's diff.
  await expect(
    svc.pulls.fileAtRef("me/proj", pr.number, "untouched.md", "head"),
  ).rejects.toMatchObject({ status: 404 });
});

test("pulls.fileAtRef ignores files added to the base branch after the PR fork", async () => {
  const pr = await svc.pulls.create("me/proj", {
    title: "base advanced",
    body: "base has an unrelated file",
    head: "feature",
    base: "main",
  });
  writeFileSync(join(repoPath, "unrelated.md"), "# base only\n");
  git(["add", "unrelated.md"]);
  git(["commit", "-qm", "base-only change"]);

  await expect(
    svc.pulls.fileAtRef("me/proj", pr.number, "unrelated.md", "head"),
  ).rejects.toMatchObject({ status: 404 });
});

test("pulls.fileAtRef resolves both sides of a renamed file", async () => {
  const pr = await svc.pulls.create("me/proj", {
    title: "rename the readme",
    body: "renames the readme",
    head: "rename-feature",
    base: "main",
  });

  await expect(
    svc.pulls.fileAtRef("me/proj", pr.number, "docs/README.md", "head"),
  ).resolves.toEqual({ status: "ok", content: "# base\n" });
  await expect(
    svc.pulls.fileAtRef("me/proj", pr.number, "README.md", "base"),
  ).resolves.toEqual({ status: "ok", content: "# base\n" });
});
