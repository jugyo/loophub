import { test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, mergePull, isIndexLockError, sleep } from "./git.ts";

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
    isIndexLockError("fatal: Unable to create '/r/.git/index.lock': File exists."),
  ).toBe(true);
  expect(
    isIndexLockError(
      "Another git process seems to be running in this repository ... index.lock",
    ),
  ).toBe(true);
  // 本物のエラー（lock 無関係）はリトライしない。
  expect(isIndexLockError("fatal: ambiguous argument 'deadbeef': unknown revision")).toBe(false);
  expect(isIndexLockError("error: Your local changes would be overwritten")).toBe(false);
  expect(isIndexLockError("")).toBe(false);
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

  const r = await mergePull(p, "main", "feat", "squash", "merge feat", "tester", {
    resetLockRetries: 20,
    resetLockBackoffMs: 5,
  });
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
  const r = await mergePull(p, "main", "feat", "squash", "merge feat", "tester", {
    resetLockRetries: 3,
    resetLockBackoffMs: 2,
  });

  expect(r.merged).toBe(false);
  // base ref はロールバックされ前進していない。
  const baseAfter = (await git(p, ["rev-parse", "main"])).stdout.trim();
  expect(baseAfter).toBe(baseBefore);

  rmSync(lock);
  rmSync(p, { recursive: true, force: true });
});
