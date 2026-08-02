import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  diffFiles,
  diffStat,
  fileAtRef,
  git,
  hasEffectiveDiff,
  isIndexLockError,
  mergePull,
  pathInDiff,
  runGitSync,
  sleep,
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
  worktreeStatus,
} from "./git.ts";
import { traceGitCommands } from "./git-trace-test-helper.ts";
import { configureSlowOperationLogging } from "./slow-operation.ts";

async function makeRepo(): Promise<string> {
  const p = mkdtempSync(join(tmpdir(), "lh-merge-lock-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "f.txt"), "base\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);
  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "f.txt"), "feat\n");
  await git(p, ["commit", "-qam", "feat"]);
  await git(p, ["checkout", "-q", "main"]);
  return p;
}

test("git commands expose their argv to slow-operation diagnostics", async () => {
  const p = await makeRepo();
  const log = vi.fn();
  configureSlowOperationLogging(log);
  const clock = vi
    .spyOn(performance, "now")
    .mockReturnValueOnce(10)
    .mockReturnValueOnce(1011);

  try {
    await git(p, ["status", "--short"]);
    expect(log).toHaveBeenCalledWith(
      `[slow-operation] kind=git duration_ms=1001.0 command=${JSON.stringify([
        "git",
        "-C",
        p,
        "status",
        "--short",
      ])}`,
    );
  } finally {
    clock.mockRestore();
    configureSlowOperationLogging();
    rmSync(p, { recursive: true, force: true });
  }
});

test("synchronous git commands expose their argv to slow-operation diagnostics", async () => {
  const p = await makeRepo();
  const log = vi.fn();
  configureSlowOperationLogging(log);
  const clock = vi
    .spyOn(performance, "now")
    .mockReturnValueOnce(10)
    .mockReturnValueOnce(1011);

  try {
    const result = runGitSync([
      "-C",
      p,
      "show-ref",
      "--verify",
      "refs/heads/main",
    ]);
    expect(result.code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      `[slow-operation] kind=git duration_ms=1001.0 command=${JSON.stringify([
        "git",
        "-C",
        p,
        "show-ref",
        "--verify",
        "refs/heads/main",
      ])}`,
    );
  } finally {
    clock.mockRestore();
    configureSlowOperationLogging();
    rmSync(p, { recursive: true, force: true });
  }
});

// index.lock 競合だけをリトライ対象に分類し、本物のエラーは即失敗扱いにする。
test("isIndexLockError matches only lock contention, not real errors", () => {
  expect(
    isIndexLockError(
      "fatal: Unable to create '/r/.git/index.lock': File exists.",
    ),
  ).toBe(true);
  expect(
    isIndexLockError(
      "Another git process seems to be running in this repository ... index.lock",
    ),
  ).toBe(true);
  // 本物のエラー（lock 無関係）はリトライしない。
  expect(
    isIndexLockError("fatal: ambiguous argument 'deadbeef': unknown revision"),
  ).toBe(false);
  expect(
    isIndexLockError("error: Your local changes would be overwritten"),
  ).toBe(false);
  expect(isIndexLockError("")).toBe(false);
});

// worktreeAdd で新規ブランチを切り、worktreeList が porcelain をパースして拾えることを検証。
test("worktreeAdd creates a branch worktree that worktreeList reports", async () => {
  const p = await makeRepo();
  const wtPath = join(p, "..", `wt-${p.split("/").pop()}`);
  await worktreeAdd(p, wtPath, "loophub/issue-1", "main");

  expect(existsSync(join(wtPath, "f.txt"))).toBe(true);
  const list = await worktreeList(p);
  const wt = list.find((w) => w.branch === "loophub/issue-1");
  expect(wt).toBeTruthy();
  expect(existsSync(wt!.path)).toBe(true);
  expect(wt!.bare).toBe(false);
  // The primary checkout is also listed, on its own branch.
  expect(list.some((w) => w.branch === "main")).toBe(true);

  await git(p, ["worktree", "remove", "--force", wtPath]);
  rmSync(p, { recursive: true, force: true });
});

// 既存ブランチを -b なしで checkout する経路（PR / 再アタッチ）。
test("worktreeAdd checks out an existing branch with existingBranch", async () => {
  const p = await makeRepo();
  const wtPath = join(p, "..", `wt2-${p.split("/").pop()}`);
  await worktreeAdd(p, wtPath, "feat", "main", { existingBranch: true });

  const wt = (await worktreeList(p)).find(
    (w) => w.path === wtPath || existsSync(wtPath),
  );
  expect(wt).toBeTruthy();
  expect(readFileSync(join(wtPath, "f.txt"), "utf8")).toBe("feat\n");

  await git(p, ["worktree", "remove", "--force", wtPath]);
  rmSync(p, { recursive: true, force: true });
});

// 既に worktree が在るパスへの add は失敗し、エラーを投げる。
test("worktreeAdd throws when the target path is already a worktree", async () => {
  const p = await makeRepo();
  const wtPath = join(p, "..", `wt3-${p.split("/").pop()}`);
  await worktreeAdd(p, wtPath, "loophub/issue-2", "main");
  await expect(
    worktreeAdd(p, wtPath, "loophub/issue-3", "main"),
  ).rejects.toThrow(/git worktree add failed/);

  await git(p, ["worktree", "remove", "--force", wtPath]);
  rmSync(p, { recursive: true, force: true });
});

// worktreeRemove は登録済み worktree を削除し、worktreeStatus は clean tree を空で返す。
test("worktreeRemove removes a clean worktree and worktreeStatus reports cleanliness", async () => {
  const p = await makeRepo();
  const wtPath = join(p, "..", `wt-rm-${p.split("/").pop()}`);
  await worktreeAdd(p, wtPath, "loophub/issue-4", "main");

  const clean = await worktreeStatus(wtPath);
  expect(clean.code).toBe(0);
  expect(clean.stdout.trim()).toBe("");

  await worktreeRemove(p, wtPath);
  expect(existsSync(wtPath)).toBe(false);
  expect(
    (await worktreeList(p)).some((w) => w.branch === "loophub/issue-4"),
  ).toBe(false);

  rmSync(p, { recursive: true, force: true });
});

// worktreeStatus は未追跡ファイルを porcelain 出力で報告する（dirty 判定の入力）。
test("worktreeStatus reports untracked files", async () => {
  const p = await makeRepo();
  const wtPath = join(p, "..", `wt-st-${p.split("/").pop()}`);
  await worktreeAdd(p, wtPath, "loophub/issue-5", "main");
  writeFileSync(join(wtPath, "scratch.txt"), "wip\n");

  const st = await worktreeStatus(wtPath);
  expect(st.code).toBe(0);
  expect(st.stdout).toContain("?? scratch.txt");

  await git(p, ["worktree", "remove", "--force", wtPath]);
  rmSync(p, { recursive: true, force: true });
});

// dirty な worktree の remove は --force 無しで失敗し、prune は live worktree を温存する。
test("worktreeRemove refuses a dirty tree; worktreePrune keeps live worktrees", async () => {
  const p = await makeRepo();
  const wtPath = join(p, "..", `wt-dirty-${p.split("/").pop()}`);
  await worktreeAdd(p, wtPath, "loophub/issue-6", "main");
  writeFileSync(join(wtPath, "f.txt"), "uncommitted\n");

  await expect(worktreeRemove(p, wtPath)).rejects.toThrow(
    /git worktree remove failed/,
  );
  // prune only drops stale admin entries; the live (dirty) worktree survives.
  await worktreePrune(p);
  expect(
    (await worktreeList(p)).some((w) => w.branch === "loophub/issue-6"),
  ).toBe(true);

  await git(p, ["worktree", "remove", "--force", wtPath]);
  rmSync(p, { recursive: true, force: true });
});

// force explicitly bypasses Git's dirty-worktree safety guard.
test("worktreeRemove force removes a dirty tree", async () => {
  const p = await makeRepo();
  const wtPath = join(p, "..", `wt-force-${p.split("/").pop()}`);
  await worktreeAdd(p, wtPath, "loophub/issue-7", "main");
  writeFileSync(join(wtPath, "f.txt"), "uncommitted\n");
  writeFileSync(join(wtPath, "scratch.txt"), "untracked\n");

  await worktreeRemove(p, wtPath, { force: true });

  expect(existsSync(wtPath)).toBe(false);
  expect(
    (await worktreeList(p)).some((w) => w.branch === "loophub/issue-7"),
  ).toBe(false);
  rmSync(p, { recursive: true, force: true });
});

// 一過性の index.lock 競合があっても、reset --hard のリトライで最終的に merge が成立する。
test("merge succeeds despite a transient index.lock held by another process", async () => {
  const p = await makeRepo();
  const lock = join(p, ".git", "index.lock");

  // base を checkout したまま、他プロセスが index.lock を握っている状態を再現。
  writeFileSync(lock, "");
  // 数回のリトライ分だけ握ってから解放（最初の数回の reset は失敗する）。
  const release = (async () => {
    await sleep(30);
    if (existsSync(lock)) rmSync(lock);
  })();

  const r = await mergePull(
    p,
    "main",
    "feat",
    "squash",
    "merge feat",
    "tester",
    {
      resetLockRetries: 20,
      resetLockBackoffMs: 5,
    },
  );
  await release;

  expect(r.merged).toBe(true);
  // 作業コピーが merge 後 HEAD に追従している。
  expect(readFileSync(join(p, "f.txt"), "utf8")).toBe("feat\n");
  rmSync(p, { recursive: true, force: true });
});

// 解放されない（恒久的な）index.lock 競合では、リトライ枯渇後にロールバックして merged:false。
test("merge rolls back when index.lock never clears", async () => {
  const p = await makeRepo();
  const lock = join(p, ".git", "index.lock");
  writeFileSync(lock, "");

  const baseBefore = (await git(p, ["rev-parse", "main"])).stdout.trim();
  const r = await mergePull(
    p,
    "main",
    "feat",
    "squash",
    "merge feat",
    "tester",
    {
      resetLockRetries: 3,
      resetLockBackoffMs: 2,
    },
  );

  expect(r.merged).toBe(false);
  // base ref はロールバックされ前進していない。
  const baseAfter = (await git(p, ["rev-parse", "main"])).stdout.trim();
  expect(baseAfter).toBe(baseBefore);

  rmSync(lock);
  rmSync(p, { recursive: true, force: true });
});

// A repo whose base moved after the branch point, so the three merge methods produce
// visibly different histories: main has 2 commits, feat has 2 commits of its own.
async function makeDivergedRepo(): Promise<{
  p: string;
  baseSha: string;
  headSha: string;
}> {
  const p = mkdtempSync(join(tmpdir(), "lh-merge-method-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "f.txt"), "base\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "a.txt"), "a\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "feat 1"]);
  writeFileSync(join(p, "b.txt"), "b\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "feat 2"]);

  // Move base forward after the branch point so base and head genuinely diverge.
  await git(p, ["checkout", "-q", "main"]);
  writeFileSync(join(p, "c.txt"), "c\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base 2"]);

  const baseSha = (await git(p, ["rev-parse", "main"])).stdout.trim();
  const headSha = (await git(p, ["rev-parse", "feat"])).stdout.trim();
  return { p, baseSha, headSha };
}

// Parents of a commit, in order, as full shas.
async function parentsOf(repoPath: string, ref: string): Promise<string[]> {
  const r = await git(repoPath, ["rev-list", "--parents", "-n", "1", ref]);
  return r.stdout.trim().split(" ").slice(1);
}

async function commitCount(repoPath: string, ref: string): Promise<number> {
  return Number((await git(repoPath, ["rev-list", "--count", ref])).stdout);
}

// #1904: squash must compress head into exactly one commit whose only parent is base —
// not a merge commit, and not head's individual commits replayed onto base.
test("squash merge adds one commit whose only parent is base", async () => {
  const { p, baseSha, headSha } = await makeDivergedRepo();
  const baseCount = await commitCount(p, "main");

  const r = await mergePull(p, "main", "feat", "squash", "feat (#1)", "tester");
  expect(r.merged).toBe(true);

  // Single parent, and that parent is the pre-merge base tip: not a merge commit.
  expect(await parentsOf(p, "main")).toEqual([baseSha]);
  // head's 2 commits became exactly 1 commit on base.
  expect(await commitCount(p, "main")).toBe(baseCount + 1);
  // head's own commits are not part of base's history.
  expect(
    (await git(p, ["merge-base", "--is-ancestor", headSha, "main"])).code,
  ).not.toBe(0);
  // Every change head introduced is in that one commit, and base's own commit survives.
  const changed = (
    await git(p, ["diff", "--name-only", baseSha, "main"])
  ).stdout.trim();
  expect(changed.split("\n")).toEqual(["a.txt", "b.txt"]);
  expect((await git(p, ["show", "main:a.txt"])).stdout).toBe("a\n");
  expect((await git(p, ["show", "main:b.txt"])).stdout).toBe("b\n");
  expect((await git(p, ["show", "main:c.txt"])).stdout).toBe("c\n");

  rmSync(p, { recursive: true, force: true });
});

// The contrast that makes the squash assertions meaningful: merge keeps both parents,
// rebase keeps head's commits as a linear history.
test("merge keeps two parents and rebase stays linear", async () => {
  const merged = await makeDivergedRepo();
  const mergedCount = await commitCount(merged.p, "main");
  const rm = await mergePull(
    merged.p,
    "main",
    "feat",
    "merge",
    "feat (#1)",
    "tester",
  );
  expect(rm.merged).toBe(true);
  expect(await parentsOf(merged.p, "main")).toEqual([
    merged.baseSha,
    merged.headSha,
  ]);
  // base 2 + head 2 + the merge commit itself.
  expect(await commitCount(merged.p, "main")).toBe(mergedCount + 3);
  rmSync(merged.p, { recursive: true, force: true });

  const rebased = await makeDivergedRepo();
  const rebasedCount = await commitCount(rebased.p, "main");
  const rr = await mergePull(
    rebased.p,
    "main",
    "feat",
    "rebase",
    "feat (#1)",
    "tester",
  );
  expect(rr.merged).toBe(true);
  // Linear: no commit in base's history has two parents, and head's commits are kept
  // as separate (replayed, hence rewritten) commits rather than compressed into one.
  expect((await git(rebased.p, ["rev-list", "--merges", "main"])).stdout).toBe(
    "",
  );
  expect(await commitCount(rebased.p, "main")).toBe(rebasedCount + 2);
  expect(await parentsOf(rebased.p, "main")).not.toContain(rebased.headSha);
  rmSync(rebased.p, { recursive: true, force: true });
});

// diffStat sums numstat over base...head: +/- line totals plus the changed-file
// count, and counts binary files (numstat "-") as a changed file with 0 lines.
test("diffStat aggregates additions, deletions and changed files", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-diffstat-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "a.txt"), "1\n2\n3\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  // a.txt: drop the last line, add two; net +2 -1.
  writeFileSync(join(p, "a.txt"), "1\n2\nx\ny\n");
  // new text file: +1.
  writeFileSync(join(p, "b.txt"), "new\n");
  // binary file: numstat reports "-" for both columns.
  writeFileSync(join(p, "c.bin"), Buffer.from([0, 1, 2, 0, 3]));
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "feat"]);

  const stat = await diffStat(p, "main", "feat");
  expect(stat.additions).toBe(3); // 2 in a.txt + 1 in b.txt
  expect(stat.deletions).toBe(1); // 1 in a.txt
  expect(stat.changedFiles).toBe(3); // a.txt, b.txt, c.bin

  // No diff against itself → all zeros.
  const empty = await diffStat(p, "feat", "feat");
  expect(empty).toEqual({ additions: 0, deletions: 0, changedFiles: 0 });

  rmSync(p, { recursive: true, force: true });
});

test("diffFiles exposes structured rename target paths", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-difffiles-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "old.txt"), "old\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  await git(p, ["mv", "old.txt", "new => target.txt"]);
  await git(p, ["commit", "-qm", "rename"]);

  const files = await diffFiles(p, "main", "feat");
  expect(files).toEqual([
    expect.objectContaining({
      filename: "old.txt => new => target.txt",
      previousFilename: "old.txt",
      headFilename: "new => target.txt",
      status: "renamed",
    }),
  ]);

  rmSync(p, { recursive: true, force: true });
});

test("diffFiles can omit whitespace-only changes without hiding substantive changes", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-difffiles-whitespace-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "only-space.ts"), "const value = 1;\n");
  writeFileSync(join(p, "mixed.ts"), "const first = 1;\nconst second = 2;\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "only-space.ts"), "  const value = 1;\n");
  writeFileSync(join(p, "mixed.ts"), "  const first = 1;\nconst second = 3;\n");
  await git(p, ["commit", "-qam", "change whitespace and value"]);

  const full = await diffFiles(p, "main", "feat");
  const ignored = await diffFiles(p, "main", "feat", {
    ignoreWhitespace: true,
  });

  expect(full.map((file) => file.filename)).toEqual([
    "mixed.ts",
    "only-space.ts",
  ]);
  expect(ignored.map((file) => file.filename)).toEqual(["mixed.ts"]);
  expect(ignored[0].patch).toContain("-const second = 2;");
  expect(ignored[0].patch).toContain("+const second = 3;");
  expect(ignored[0].patch).not.toContain("-const first = 1;");
  expect(ignored[0].patch).not.toContain("+  const first = 1;");

  rmSync(p, { recursive: true, force: true });
});

test("diffFiles keeps rename edits as old-vs-new patches", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-difffiles-rename-edit-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "old.txt"), "one\ntwo\nthree\nfour\nfive\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  await git(p, ["mv", "old.txt", "new.txt"]);
  writeFileSync(join(p, "new.txt"), "one\ntwo\nTHREE\nfour\nfive\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "rename and edit"]);

  const files = await diffFiles(p, "main", "feat");
  expect(files).toEqual([
    expect.objectContaining({
      filename: "old.txt => new.txt",
      previousFilename: "old.txt",
      headFilename: "new.txt",
      status: "renamed",
      patch: expect.stringContaining("-three"),
    }),
  ]);
  expect(files[0].patch).toContain("+THREE");
  expect(files[0].patch).not.toContain("@@ -0,0");

  rmSync(p, { recursive: true, force: true });
});

test("diffFiles keeps copied-file patches scoped to the copy target", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-difffiles-copy-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  await git(p, ["config", "diff.renames", "copies"]);
  writeFileSync(join(p, "source.txt"), "one\ntwo\nthree\nfour\nfive\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "copy.txt"), "one\ntwo\nthree\nfour\nfive\n");
  writeFileSync(join(p, "source.txt"), "one\ntwo\nTHREE\nfour\nfive\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "copy and edit source"]);

  const files = await diffFiles(p, "main", "feat");
  const copied = files.find((file) => file.status === "copied");
  expect(copied).toEqual(
    expect.objectContaining({
      filename: "source.txt => copy.txt",
      previousFilename: "source.txt",
      headFilename: "copy.txt",
      patch: expect.stringContaining("copy from source.txt"),
    }),
  );
  expect(copied?.patch).toContain("copy to copy.txt");
  expect(copied?.patch).toContain("@@ -0,0 +1,5 @@");
  expect(copied?.patch).toContain("+three");
  expect(copied?.patch).not.toContain("-three");
  expect(copied?.patch).not.toContain("+THREE");

  rmSync(p, { recursive: true, force: true });
});

test("diffFiles pairs added patches by target path for mixed renames and copies", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-difffiles-rename-copy-"));
  try {
    await git(p, ["init", "-q", "-b", "main"]);
    await git(p, ["config", "user.email", "t@t.local"]);
    await git(p, ["config", "user.name", "tester"]);
    await git(p, ["config", "diff.renames", "copies"]);
    writeFileSync(join(p, "rename-old.txt"), "rename me\n");
    writeFileSync(join(p, "source.txt"), "one\ntwo\nthree\nfour\nfive\n");
    await git(p, ["add", "-A"]);
    await git(p, ["commit", "-qm", "base"]);

    await git(p, ["checkout", "-q", "-b", "feat"]);
    await git(p, ["mv", "rename-old.txt", "a-renamed.txt"]);
    writeFileSync(join(p, "z-copy.txt"), "one\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(p, "source.txt"), "one\ntwo\nTHREE\nfour\nfive\n");
    await git(p, ["add", "-A"]);
    await git(p, ["commit", "-qm", "rename and copy"]);

    const files = await diffFiles(p, "main", "feat");
    const copied = files.find((file) => file.status === "copied");
    expect(copied).toEqual(
      expect.objectContaining({
        filename: "source.txt => z-copy.txt",
        previousFilename: "source.txt",
        headFilename: "z-copy.txt",
        patch: expect.stringContaining("@@ -0,0 +1,5 @@"),
      }),
    );
    expect(copied?.patch).toContain("+three");
    expect(copied?.patch).not.toContain("+rename me");
    expect(copied?.patch).not.toContain("+THREE");
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
});

test("diffFiles preserves tabs in structured filenames", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-difffiles-tab-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "a\tb.txt"), "old\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "a\tb.txt"), "new\n");
  await git(p, ["commit", "-am", "change tab path"]);

  const files = await diffFiles(p, "main", "feat");
  expect(files).toEqual([
    expect.objectContaining({
      filename: "a\tb.txt",
      headFilename: "a\tb.txt",
      status: "modified",
    }),
  ]);

  rmSync(p, { recursive: true, force: true });
});

test("diffFiles preserves statuses for quoted paths", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-difffiles-status-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "delete\nfile.txt"), "delete\n");
  writeFileSync(join(p, "old\nname.txt"), "rename\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  rmSync(join(p, "delete\nfile.txt"));
  writeFileSync(join(p, "add\nfile.txt"), "add\n");
  await git(p, ["mv", "old\nname.txt", "new\nname.txt"]);
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "quoted paths"]);

  const files = await diffFiles(p, "main", "feat");
  expect(files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        filename: "add\nfile.txt",
        headFilename: "add\nfile.txt",
        status: "added",
      }),
      expect.objectContaining({
        filename: "delete\nfile.txt",
        headFilename: "delete\nfile.txt",
        status: "removed",
      }),
      expect.objectContaining({
        previousFilename: "old\nname.txt",
        headFilename: "new\nname.txt",
        status: "renamed",
      }),
    ]),
  );

  rmSync(p, { recursive: true, force: true });
});

test("diffFiles fetches normal and added-file patches in batched git calls and preserves special patch lines", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-difffiles-single-patch-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "no-newline.txt"), "old");
  writeFileSync(join(p, "binary.bin"), Buffer.from([0, 1, 2, 0, 3]));
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "no-newline.txt"), "new");
  writeFileSync(join(p, "binary.bin"), Buffer.from([0, 4, 5, 0, 6]));
  writeFileSync(join(p, "added.txt"), "added\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "change files"]);

  const { result: files, commands } = await traceGitCommands(() =>
    diffFiles(p, "main", "feat"),
  );
  expect(
    commands.filter((command) => command.startsWith("diff ")),
  ).toHaveLength(3);
  expect(
    files.find((file) => file.filename === "no-newline.txt")?.patch,
  ).toContain("\\ No newline at end of file");
  expect(files.find((file) => file.filename === "binary.bin")).toMatchObject({
    additions: 0,
    deletions: 0,
    patch: expect.stringContaining("Binary files"),
  });

  rmSync(p, { recursive: true, force: true });
});

test("fileAtRef returns content, or 'missing'/'binary' for an absent or binary file", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-fileatref-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "README.md"), "# base\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "README.md"), "# head\n");
  writeFileSync(join(p, "new.md"), "# new file\n"); // added on feat, absent from main
  writeFileSync(join(p, "img.bin"), Buffer.from([0, 1, 2, 0, 3])); // binary
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "feat"]);

  expect(await fileAtRef(p, "main", "README.md")).toEqual({
    status: "ok",
    content: "# base\n",
  });
  expect(await fileAtRef(p, "feat", "README.md")).toEqual({
    status: "ok",
    content: "# head\n",
  });
  expect(await fileAtRef(p, "main", "new.md")).toEqual({ status: "missing" });
  expect(await fileAtRef(p, "feat", "img.bin")).toEqual({ status: "binary" });

  rmSync(p, { recursive: true, force: true });
});

test("hasEffectiveDiff is true for real changes and false when commits net out (#1243)", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-haseffdiff-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "f.txt"), "base\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  // A branch with a real change to base...head reports true.
  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "f.txt"), "feat\n");
  await git(p, ["commit", "-qam", "feat"]);
  expect(await hasEffectiveDiff(p, "main", "feat")).toBe(true);

  // A branch with commits ahead of base whose net changes cancel out (add then
  // revert) has no effective diff even though base..feat is non-empty.
  await git(p, ["checkout", "-q", "-b", "netempty", "main"]);
  writeFileSync(join(p, "g.txt"), "temp\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "add g.txt"]);
  rmSync(join(p, "g.txt"));
  await git(p, ["commit", "-qam", "remove g.txt"]);
  const ahead = await git(p, ["rev-list", "--count", "main..netempty"]);
  expect(Number(ahead.stdout.trim())).toBeGreaterThanOrEqual(1);
  expect(await hasEffectiveDiff(p, "main", "netempty")).toBe(false);

  // No diff against itself.
  expect(await hasEffectiveDiff(p, "main", "main")).toBe(false);

  rmSync(p, { recursive: true, force: true });
});

test("pathInDiff reports only files actually changed in base...head", async () => {
  const p = mkdtempSync(join(tmpdir(), "lh-pathindiff-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "changed.md"), "base\n");
  writeFileSync(join(p, "untouched.md"), "untouched\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);

  await git(p, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(p, "changed.md"), "head\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qam", "feat"]);

  expect(await pathInDiff(p, "main", "feat", "changed.md")).toBe(true);
  expect(await pathInDiff(p, "main", "feat", "untouched.md")).toBe(false);
  expect(await pathInDiff(p, "main", "feat", "nope.md")).toBe(false);

  // Git pathspec magic (e.g. an exclude-only pathspec, which implicitly matches every other
  // changed file) must not be able to make an out-of-scope `path` look like a diff member.
  expect(
    await pathInDiff(p, "main", "feat", ":(exclude)nonexistent12345"),
  ).toBe(false);
  expect(await pathInDiff(p, "main", "feat", "*.md")).toBe(false);

  rmSync(p, { recursive: true, force: true });
});
