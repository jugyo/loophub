import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  diffFiles,
  diffStat,
  fileAtRef,
  git,
  isIndexLockError,
  mergePull,
  pathInDiff,
  sleep,
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
  worktreeStatus,
} from "./git.ts";

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
      patch: expect.stringContaining("+one"),
    }),
  );
  expect(copied?.patch).toContain("@@ -0,0");
  expect(copied?.patch).not.toContain("-three");
  expect(copied?.patch).not.toContain("+THREE");

  rmSync(p, { recursive: true, force: true });
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
