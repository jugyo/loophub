import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-main-merge-undo-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let repoPath: string;

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function commitOn(branch: string, file: string, body: string, message: string) {
  git(["checkout", "-q", branch]);
  writeFileSync(join(repoPath, file), body);
  git(["add", "-A"]);
  git(["commit", "-qm", message]);
}

async function createMergedPr(
  branch: string,
  method: "merge" | "squash" = "merge",
) {
  const issue = (await svc.issues.create("me/proj", {
    title: `issue ${branch}`,
  })) as any;
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch.replaceAll("/", "-")}.txt`), branch);
  git(["add", "-A"]);
  git(["commit", "-qm", `impl ${branch}`]);
  git(["checkout", "-q", "main"]);
  const before = git(["rev-parse", "main"]);
  const pr = (await svc.pulls.create("me/proj", {
    title: `pr ${branch}`,
    head: branch,
    base: "main",
    issue: issue.number,
  })) as any;
  const merged = await svc.pulls.merge("me/proj", pr.number, method);
  return { issue, pr, before, mergeSha: merged.sha };
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-main-merge-undo-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "base.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("undoMainMerge rewinds main tip merge and reopens the PR and linked issue", async () => {
  const { issue, pr, before, mergeSha } =
    await createMergedPr("feat/undo-success");

  const result = await svc.pulls.undoMainMerge("me/proj", pr.number);

  expect(result).toMatchObject({ undone: true, sha: before });
  expect(git(["rev-parse", "main"])).toBe(before);
  const afterPr = (await svc.pulls.get("me/proj", pr.number)) as any;
  expect(afterPr.state).toBe("open");
  expect(afterPr.merged).toBe(false);
  expect(afterPr.merge_commit_sha).toBeNull();
  const afterIssue = svc.issues.get("me/proj", issue.number) as any;
  expect(afterIssue.state).toBe("open");

  const repo = S.getRepo("me", "proj")!;
  const rawPr = S.getIssue(repo.id, pr.number)!;
  const rawAudits = S.listMainMergeUndos(rawPr.id);
  expect(rawAudits).toHaveLength(1);
  expect(rawAudits[0]).toMatchObject({
    undone_from_sha: mergeSha,
    previous_main_sha: before,
    merge_commit_sha: mergeSha,
  });
});

test("undoMainMerge does not reopen a linked issue that the merge did not close", async () => {
  const issue = (await svc.issues.create("me/proj", {
    title: "already closed issue",
  })) as any;
  svc.issues.update("me/proj", issue.number, { state: "closed" });
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "feat/undo-closed-issue"]);
  writeFileSync(join(repoPath, "closed-issue.txt"), "closed\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "impl closed issue"]);
  git(["checkout", "-q", "main"]);
  const pr = (await svc.pulls.create("me/proj", {
    title: "pr closed issue",
    head: "feat/undo-closed-issue",
    base: "main",
    issue: issue.number,
  })) as any;
  await svc.pulls.merge("me/proj", pr.number, "merge");

  await svc.pulls.undoMainMerge("me/proj", pr.number);

  const afterIssue = svc.issues.get("me/proj", issue.number) as any;
  expect(afterIssue.state).toBe("closed");
});

test("undoMainMerge does not reopen a linked issue that was reclosed after the merge", async () => {
  const { issue, pr } = await createMergedPr("feat/undo-reclosed-issue");
  svc.issues.update("me/proj", issue.number, { state: "open" });
  svc.issues.update("me/proj", issue.number, { state: "closed" });

  await svc.pulls.undoMainMerge("me/proj", pr.number);

  const afterIssue = svc.issues.get("me/proj", issue.number) as any;
  expect(afterIssue.state).toBe("closed");
});

test("undoMainMerge refuses when main has advanced after the PR merge", async () => {
  const { pr, mergeSha } = await createMergedPr("feat/undo-advanced");
  commitOn("main", "after.txt", "after\n", "after merge");
  const advanced = git(["rev-parse", "main"]);

  await expect(svc.pulls.undoMainMerge("me/proj", pr.number)).rejects.toThrow(
    "not the PR merge commit",
  );

  expect(git(["rev-parse", "main"])).toBe(advanced);
  const afterPr = (await svc.pulls.get("me/proj", pr.number)) as any;
  expect(afterPr.merged).toBe(true);
  expect(afterPr.merge_commit_sha).toBe(mergeSha);
});

test("undoMainMerge refuses a squash merge because it is not a merge commit", async () => {
  const { pr, mergeSha } = await createMergedPr("feat/undo-squash", "squash");

  await expect(svc.pulls.undoMainMerge("me/proj", pr.number)).rejects.toThrow(
    "Recorded squash merge commit has 1 parent(s)",
  );

  expect(git(["rev-parse", "main"])).toBe(mergeSha);
  const afterPr = (await svc.pulls.get("me/proj", pr.number)) as any;
  expect(afterPr.merged).toBe(true);
});

test("undoMainMerge refuses archived repositories before mutating git", async () => {
  const { pr, mergeSha } = await createMergedPr("feat/undo-archived");
  svc.repos.setArchived("me/proj", true);
  const archivedView = (await svc.pulls.get("me/proj", pr.number)) as any;
  expect(archivedView.main_merge_undo).toMatchObject({
    can_undo: false,
    reason: "Repository is archived",
  });

  await expect(svc.pulls.undoMainMerge("me/proj", pr.number)).rejects.toThrow(
    "Repository is archived",
  );

  expect(git(["rev-parse", "main"])).toBe(mergeSha);
  svc.repos.setArchived("me/proj", false);
});
