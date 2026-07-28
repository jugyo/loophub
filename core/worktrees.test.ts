import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test as vitestTest } from "vitest";
import { git, worktreeAdd } from "./git.ts";
import { traceGitCommands } from "./git-trace-test-helper.ts";
import { WORKTREE_AUTO_PRUNE_GRACE_MS } from "./worktree-prune.ts";

// Isolate the DB and sibling worktree fixtures before db.ts runs its import-time setup.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "lh-worktrees-"));
const REAL_GIT_TIMEOUT_MS = 30_000;
process.env.LOOPHUB_HOME = TEST_ROOT;
process.env.LOOPHUB_DB = join(TEST_ROOT, "test.db");

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

function worktreePath(name: string): string {
  return join(TEST_ROOT, name);
}

function test(name: string, run: () => Promise<void>): void {
  vitestTest(name, run, REAL_GIT_TIMEOUT_MS);
}

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
}, REAL_GIT_TIMEOUT_MS);

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
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
      worktreePath(`wt-${repo.id}-${n}`),
      `loophub/issue-${n}`,
      "main",
    );
  }
  // a worktree #999 with no issue row → keep (cannot confirm done-ness)
  await worktreeAdd(
    repo.path,
    worktreePath(`wt-${repo.id}-999`),
    "loophub/issue-999",
    "main",
  );
  // make #3 dirty with a real untracked file
  writeFileSync(join(worktreePath(`wt-${repo.id}-3`), "wip.txt"), "x\n");

  const cwd = worktreePath(`wt-${repo.id}-4`);
  const { result: entries, commands } = await traceGitCommands(() =>
    svc.worktrees.plan({ repo: "me/plan", cwd }),
  );
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
  // no-force still checks every managed worktree except cwd for uncommitted changes
  expect(
    commands.filter((command) => command.startsWith("status ")),
  ).toHaveLength(4);

  // cleanup worktrees
  for (const n of [1, 2, 3, 4, 999]) {
    await git(repo.path, [
      "worktree",
      "remove",
      "--force",
      worktreePath(`wt-${repo.id}-${n}`),
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

  const wtPath = worktreePath(`wt-merged-${repo.id}-1`);
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

test("plan removes clean finished PR worktrees but keeps dirty and cwd safety guards", async () => {
  const repo = await makeRepo("me/superseded");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "parallel work",
    "",
    "me",
  ) as any;
  const attempts = [];
  for (const suffix of ["clean", "dirty", "cwd"]) {
    const pr = S.createIssue(repo.id, "pull", suffix, "", "me") as any;
    const head = `loophub/pr-${pr.number}`;
    S.createPull(pr.id, head, "main", null, issue.id);
    const path = worktreePath(`wt-superseded-${repo.id}-${suffix}`);
    await worktreeAdd(repo.path, path, head, "main");
    attempts.push({ pr, path, suffix });
  }
  writeFileSync(
    `${attempts.find((attempt) => attempt.suffix === "dirty")!.path}/wip.txt`,
    "unfinished\n",
  );

  svc.issues.update("me/superseded", issue.number, { state: "closed" });

  const cwdPath = attempts.find((attempt) => attempt.suffix === "cwd")!.path;
  const entries = await svc.worktrees.plan({
    repo: "me/superseded",
    cwd: cwdPath,
  });
  const byNumber = new Map(entries.map((entry) => [entry.issue, entry]));
  const clean = attempts.find((attempt) => attempt.suffix === "clean")!;
  const dirty = attempts.find((attempt) => attempt.suffix === "dirty")!;
  const cwd = attempts.find((attempt) => attempt.suffix === "cwd")!;
  expect(byNumber.get(clean.pr.number)).toMatchObject({
    action: "remove",
    reason: "issue closed",
  });
  expect(byNumber.get(dirty.pr.number)).toMatchObject({
    action: "skip",
    reason: "uncommitted or untracked changes",
  });
  expect(byNumber.get(cwd.pr.number)).toMatchObject({
    action: "skip",
    reason: "current working directory",
  });

  for (const attempt of attempts) {
    await git(repo.path, ["worktree", "remove", "--force", attempt.path]);
  }
});

// remove() deletes a clean done worktree; tidy() prunes stale admin entries.
test("remove deletes a clean worktree; tidy prunes admin entries", async () => {
  const repo = await makeRepo("me/remove");
  const i1 = S.createIssue(repo.id, "issue", "closed", "", "me") as any;
  S.updateIssue(i1.id, { state: "closed" });
  const wtPath = worktreePath(`wt-rm-${repo.id}-1`);
  await worktreeAdd(repo.path, wtPath, "loophub/issue-1", "main");

  const { result: res, commands } = await traceGitCommands(() =>
    svc.worktrees.remove({
      repoPath: repo.path,
      path: wtPath,
      issue: 1,
    }),
  );
  expect(res.removed).toBe(true);
  expect(existsSync(wtPath)).toBe(false);
  expect(
    commands.filter((command) =>
      command.startsWith("worktree list --porcelain"),
    ),
  ).toHaveLength(1);

  await svc.worktrees.tidy("me/remove"); // no throw; stale entries pruned
  const after = await svc.worktrees.plan({
    repo: "me/remove",
    cwd: "/nowhere",
  });
  expect(after).toEqual([]);
});

test("force plans and removes modified, untracked, and clean done worktrees", async () => {
  const repo = await makeRepo("me/force-remove");
  const fixtures = [];
  for (const kind of ["modified", "untracked", "clean"] as const) {
    const issue = S.createIssue(repo.id, "issue", kind, "", "me") as any;
    S.updateIssue(issue.id, { state: "closed" });
    const path = worktreePath(`wt-force-${repo.id}-${issue.number}`);
    await worktreeAdd(repo.path, path, `loophub/issue-${issue.number}`, "main");
    fixtures.push({ issue, kind, path });
  }
  writeFileSync(join(fixtures[0].path, "f.txt"), "modified\n");
  writeFileSync(join(fixtures[1].path, "scratch.txt"), "untracked\n");

  const { result: entries, commands } = await traceGitCommands(() =>
    svc.worktrees.plan({
      repo: "me/force-remove",
      cwd: "/nowhere",
      force: true,
    }),
  );
  expect(entries).toHaveLength(3);
  expect(entries.every((entry) => entry.action === "remove")).toBe(true);
  // Baseline: one status per managed worktree (3). Force makes dirtiness irrelevant: 3 -> 0.
  expect(commands.filter((command) => command.startsWith("status "))).toEqual(
    [],
  );

  for (const fixture of fixtures) {
    const res = await svc.worktrees.remove({
      repoPath: repo.path,
      path: fixture.path,
      issue: fixture.issue.number,
      force: true,
    });
    expect(res.removed, fixture.kind).toBe(true);
    expect(existsSync(fixture.path), fixture.kind).toBe(false);
  }
});

test("removeMany verifies worktrees once per repository before removing multiple candidates", async () => {
  const repos = [await makeRepo("me/batch-a"), await makeRepo("me/batch-b")];
  const fixtures = [];
  for (const [repoIndex, repo] of repos.entries()) {
    const candidateCount = repoIndex === 0 ? 2 : 1;
    for (let index = 0; index < candidateCount; index++) {
      const issue = S.createIssue(
        repo.id,
        "issue",
        `candidate-${index}`,
        "",
        "me",
      ) as any;
      S.updateIssue(issue.id, { state: "closed" });
      const path = worktreePath(`wt-batch-${repo.id}-${issue.number}`);
      await worktreeAdd(
        repo.path,
        path,
        `loophub/issue-${issue.number}`,
        "main",
      );
      fixtures.push({ repo, issue, path });
    }
  }

  const entries = await svc.worktrees.plan({
    cwd: "/nowhere",
    force: true,
  });
  expect(entries).toHaveLength(3);
  const { result: results, commands } = await traceGitCommands(() =>
    svc.worktrees.removeMany(
      entries.map((entry) => ({ ...entry, force: true })),
    ),
  );

  expect(results.every((result) => result.removed)).toBe(true);
  // Baseline remove() refreshed once per candidate (3). Batch refreshes once per repo: 3 -> 2.
  expect(
    commands.filter((command) =>
      command.startsWith("worktree list --porcelain"),
    ),
  ).toHaveLength(2);
  expect(
    commands.filter((command) => command.startsWith("worktree remove ")),
  ).toHaveLength(3);
  expect(fixtures.every((fixture) => !existsSync(fixture.path))).toBe(true);
});

// remove() re-asserts the branch invariant: a path that is no longer a loophub/issue-<n>
// worktree (or the wrong issue number) is refused, not force-deleted.
test("remove refuses when the path is no longer the expected worktree", async () => {
  const repo = await makeRepo("me/guard");
  const res = await svc.worktrees.remove({
    repoPath: repo.path,
    path: worktreePath("does-not-exist"),
    issue: 7,
  });
  expect(res.removed).toBe(false);
  expect(res.reason).toContain("no longer a loophub-managed worktree for #7");
});

// plan()/remove() also recognize the current loophub/pr-<n> convention (#463), not just the
// legacy loophub/issue-<n> one exercised above.
test("plan and remove recognize the current loophub/pr-<n> convention", async () => {
  const repo = await makeRepo("me/prconv");
  const issue = S.createIssue(repo.id, "issue", "feature", "", "me") as any; // #1
  const pr = S.createIssue(repo.id, "pull", "impl", "", "me") as any; // #2
  S.createPull(pr.id, "loophub/pr-2", "main", null, issue.id);
  S.setMerged(pr.id, "deadbeef", "squash");

  const wtPath = worktreePath(`wt-prconv-${repo.id}-2`);
  await worktreeAdd(repo.path, wtPath, "loophub/pr-2", "main");

  const entries = await svc.worktrees.plan({
    repo: "me/prconv",
    cwd: "/nowhere",
  });
  const e2 = entries.find((e) => e.issue === 2);
  expect(e2?.action).toBe("remove");
  expect(e2?.reason).toBe("PR merged");

  const res = await svc.worktrees.remove({
    repoPath: repo.path,
    path: wtPath,
    issue: 2,
  });
  expect(res.removed).toBe(true);
  expect(existsSync(wtPath)).toBe(false);
});

// #1837: the worker's unattended sweep. It scans every registered repository and removes only the
// worktrees whose work finished at least a full day ago — dirty ones included, since the day of
// grace has already passed.
test("autoPrune removes finished worktrees past the grace period and keeps the rest", async () => {
  const repo = await makeRepo("me/auto-prune");
  const merged = S.createIssue(repo.id, "pull", "merged", "", "me") as any;
  S.createPull(merged.id, `loophub/pr-${merged.number}`, "main", null);
  S.setMerged(merged.id, "deadbeef", "squash");
  const open = S.createIssue(repo.id, "pull", "in progress", "", "me") as any;
  S.createPull(open.id, `loophub/pr-${open.number}`, "main", null);

  const mergedPath = worktreePath(`wt-auto-${repo.id}-${merged.number}`);
  const openPath = worktreePath(`wt-auto-${repo.id}-${open.number}`);
  const adhocPath = worktreePath(`wt-auto-${repo.id}-adhoc`);
  await worktreeAdd(
    repo.path,
    mergedPath,
    `loophub/pr-${merged.number}`,
    "main",
  );
  await worktreeAdd(repo.path, openPath, `loophub/pr-${open.number}`, "main");
  await worktreeAdd(repo.path, adhocPath, "scratch", "main");
  // Uncommitted work in the finished attempt: force removal must not be blocked by it.
  writeFileSync(join(mergedPath, "wip.txt"), "unfinished\n");

  const mergedAt = Date.parse(S.getPull(merged.id)!.merged_at!);

  // One millisecond short of 24h after the merge: nothing is a candidate yet.
  const held = await svc.worktrees.autoPrune({
    cwd: "/nowhere",
    nowMs: mergedAt + WORKTREE_AUTO_PRUNE_GRACE_MS - 1,
  });
  // Only the two loophub/pr-<n> worktrees are scanned; the ad-hoc branch is not ours.
  expect(held).toEqual({ scanned: 2, candidates: 0, removed: 0, failed: [] });
  expect(existsSync(mergedPath)).toBe(true);

  // At the boundary the merged attempt goes; open work and the ad-hoc worktree stay.
  const swept = await svc.worktrees.autoPrune({
    cwd: "/nowhere",
    nowMs: mergedAt + WORKTREE_AUTO_PRUNE_GRACE_MS,
  });
  expect(swept).toEqual({ scanned: 2, candidates: 1, removed: 1, failed: [] });
  expect(existsSync(mergedPath)).toBe(false);
  expect(existsSync(openPath)).toBe(true);
  expect(existsSync(adhocPath)).toBe(true);

  for (const path of [openPath, adhocPath]) {
    await git(repo.path, ["worktree", "remove", "--force", path]);
  }
});
