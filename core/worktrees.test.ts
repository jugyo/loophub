import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { git, worktreeAdd } from "./git.ts";

// Isolate the DB before db.ts runs its import-time setup (see AGENTS.md § Tests).
const HOME = mkdtempSync(join(tmpdir(), "lh-worktrees-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

// A real git repo with one commit on main, registered in the DB.
async function makeRepo(name: string): Promise<{ id: number; path: string }> {
  const path = mkdtempSync(join(tmpdir(), "lh-wt-repo-"));
  await git(path, ["init", "-q", "-b", "main"]);
  await git(path, ["config", "user.email", "t@t.local"]);
  await git(path, ["config", "user.name", "tester"]);
  writeFileSync(join(path, "f.txt"), "base\n");
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-qm", "base"]);
  const repo = S.createRepo(name, path, "main");
  return { id: repo.id, path };
}

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// plan() classifies each loophub/issue-<n> worktree from issue state, dirtiness and cwd; the
// primary checkout and off-convention branches are ignored.
test("plan classifies done/open/dirty/missing/cwd worktrees", async () => {
  const repo = await makeRepo("me/plan");

  // #1 closed issue → remove candidate
  const i1 = S.createIssue(repo.id, "issue", "closed", "", "me") as any;
  S.updateIssue(i1.id, { state: "closed" });
  // #2 open issue → keep
  S.createIssue(repo.id, "issue", "open", "", "me");
  // #3 closed but dirty → skip
  const i3 = S.createIssue(repo.id, "issue", "closed-dirty", "", "me") as any;
  S.updateIssue(i3.id, { state: "closed" });
  // #4 closed but will be passed as cwd → skip (cwd wins over remove)
  const i4 = S.createIssue(repo.id, "issue", "closed-cwd", "", "me") as any;
  S.updateIssue(i4.id, { state: "closed" });

  for (const n of [1, 2, 3, 4]) {
    await worktreeAdd(
      repo.path,
      join(repo.path, "..", `wt-${repo.id}-${n}`),
      `loophub/issue-${n}`,
      "main",
    );
  }
  // a worktree #999 with no issue row → keep (cannot confirm done-ness)
  await worktreeAdd(
    repo.path,
    join(repo.path, "..", `wt-${repo.id}-999`),
    "loophub/issue-999",
    "main",
  );
  // make #3 dirty with a real untracked file
  writeFileSync(join(repo.path, "..", `wt-${repo.id}-3`, "wip.txt"), "x\n");

  const cwd = join(repo.path, "..", `wt-${repo.id}-4`);
  const entries = await svc.worktrees.plan({ repo: "me/plan", cwd });
  const byIssue = new Map(entries.map((e) => [e.issue, e]));

  expect(byIssue.get(1)?.action).toBe("remove");
  expect(byIssue.get(1)?.reason).toBe("issue closed");
  expect(byIssue.get(2)?.action).toBe("keep");
  expect(byIssue.get(3)?.action).toBe("skip"); // dirty wins over closed
  expect(byIssue.get(4)?.action).toBe("skip"); // cwd wins over closed
  expect(byIssue.get(4)?.reason).toBe("current working directory");
  expect(byIssue.get(999)?.action).toBe("keep");
  expect(byIssue.get(999)?.reason).toBe("issue not found in LoopHub");
  // the primary checkout (branch main) is never an entry
  expect(entries.some((e) => e.branch === "main")).toBe(false);

  // cleanup worktrees
  for (const n of [1, 2, 3, 4, 999]) {
    await git(repo.path, [
      "worktree",
      "remove",
      "--force",
      join(repo.path, "..", `wt-${repo.id}-${n}`),
    ]);
  }
});

// An issue whose linked PR is merged is a removal candidate even while the issue itself stays
// open — done-ness via "PR merged".
test("plan marks a worktree as remove when its linked PR is merged", async () => {
  const repo = await makeRepo("me/merged");
  const issue = S.createIssue(repo.id, "issue", "feature", "", "me") as any; // #1, open
  const pr = S.createIssue(repo.id, "pull", "impl", "", "me") as any; // #2
  S.createPull(pr.id, "loophub/issue-1", "main", null, issue.id);
  S.setMerged(pr.id, "deadbeef", "squash"); // merge the linked PR

  const wtPath = join(repo.path, "..", `wt-merged-${repo.id}-1`);
  await worktreeAdd(repo.path, wtPath, "loophub/issue-1", "main");

  const entries = await svc.worktrees.plan({
    repo: "me/merged",
    cwd: "/nowhere",
  });
  const e1 = entries.find((e) => e.issue === 1);
  expect(e1?.action).toBe("remove");
  expect(e1?.reason).toBe("PR merged");

  await git(repo.path, ["worktree", "remove", "--force", wtPath]);
});

// remove() deletes a clean done worktree; tidy() prunes stale admin entries.
test("remove deletes a clean worktree; tidy prunes admin entries", async () => {
  const repo = await makeRepo("me/remove");
  const i1 = S.createIssue(repo.id, "issue", "closed", "", "me") as any;
  S.updateIssue(i1.id, { state: "closed" });
  const wtPath = join(repo.path, "..", `wt-rm-${repo.id}-1`);
  await worktreeAdd(repo.path, wtPath, "loophub/issue-1", "main");

  const res = await svc.worktrees.remove({
    repoPath: repo.path,
    path: wtPath,
    issue: 1,
  });
  expect(res.removed).toBe(true);
  expect(existsSync(wtPath)).toBe(false);

  await svc.worktrees.tidy("me/remove"); // no throw; stale entries pruned
  const after = await svc.worktrees.plan({
    repo: "me/remove",
    cwd: "/nowhere",
  });
  expect(after.some((e) => e.issue === 1)).toBe(false);
});

// remove() re-asserts the branch invariant: a path that is no longer a loophub/issue-<n>
// worktree (or the wrong issue number) is refused, not force-deleted.
test("remove refuses when the path is no longer the expected worktree", async () => {
  const repo = await makeRepo("me/guard");
  const res = await svc.worktrees.remove({
    repoPath: repo.path,
    path: join(repo.path, "..", "does-not-exist"),
    issue: 7,
  });
  expect(res.removed).toBe(false);
  expect(res.reason).toContain("no longer a loophub/issue-7 worktree");
});
