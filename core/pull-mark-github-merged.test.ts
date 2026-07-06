import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-mark-gh-merged-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let repoPath: string;
let ghNumber = 1000;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-mark-gh-merged-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

// Mirrors github-merge-sync.test.ts's setup: a PR exported to (and linked with) a GitHub PR, but
// not yet flagged github_merged — the state markGithubMerged operates on.
async function openGithubLinkedPull(linkedIssueNumber?: number) {
  const branch = `feature-${ghNumber}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature work"]);
  git(["checkout", "-q", "main"]);
  const pr = (await svc.pulls.create("me/proj", {
    title: "feat",
    head: branch,
    base: "main",
    issue: linkedIssueNumber,
  })) as any;
  svc.pulls.recordGithubPull("me/proj", pr.number, {
    github_number: ghNumber++,
    url: `https://github.com/me/proj/pull/${pr.number}`,
  });
  const repo = await svc.repos.get("me/proj");
  const issue = S.getIssue(repo!.id, pr.number)!;
  return { number: pr.number, issueId: issue.id };
}

test("markGithubMerged refuses before github-merge-sync has detected the merge (#813)", async () => {
  const { number } = await openGithubLinkedPull();
  await expect(
    svc.pulls.markGithubMerged("me/proj", number, undefined),
  ).rejects.toThrow("GitHub PR is not yet detected as merged");
});

test("markGithubMerged closes the PR and its linked issue without a local git merge, tagging a distinct merge_method (#813)", async () => {
  const linkedIssue = (await svc.issues.create("me/proj", {
    title: "close me",
  })) as any;
  const { number, issueId } = await openGithubLinkedPull(linkedIssue.number);
  S.setGithubMerged(issueId, "2026-04-04T00:00:00Z");

  const result = await svc.pulls.markGithubMerged("me/proj", number, undefined);
  expect(result).toEqual({ merged: true });

  // merged_at/method/sha are the "did this really run a git merge?" provenance the issue's AC
  // asks for — a local merge always carries a real sha, so a null sha + "github" method are the
  // signal that this PR closed via the GitHub-detected path instead.
  const pull = S.getPull(issueId)!;
  expect(pull.merged).toBe(1);
  expect(pull.merged_at).toBe("2026-04-04T00:00:00Z");
  expect(pull.merge_method).toBe("github");
  expect(pull.merge_commit_sha).toBeNull();

  const after = (await svc.pulls.get("me/proj", number)) as any;
  expect(after.merged).toBe(true);
  expect(after.state).toBe("closed");

  const linkedAfter = (await svc.issues.get(
    "me/proj",
    linkedIssue.number,
  )) as any;
  expect(linkedAfter.state).toBe("closed");
});

test("markGithubMerged refuses a PR that's already merged (#813)", async () => {
  const { number, issueId } = await openGithubLinkedPull();
  S.setGithubMerged(issueId, "2026-05-05T00:00:00Z");
  await svc.pulls.markGithubMerged("me/proj", number, undefined);

  await expect(
    svc.pulls.markGithubMerged("me/proj", number, undefined),
  ).rejects.toThrow("Pull Request is already merged");
});

test("markGithubMerged refuses a PR that was closed without merging, even once GitHub reports it merged (#813)", async () => {
  const { number, issueId } = await openGithubLinkedPull();
  await svc.pulls.update("me/proj", number, { state: "closed" }, undefined);
  S.setGithubMerged(issueId, "2026-06-06T00:00:00Z");

  await expect(
    svc.pulls.markGithubMerged("me/proj", number, undefined),
  ).rejects.toThrow("Pull Request is not open");
});
