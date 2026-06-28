import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-serialize-conflict-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

// Reproduce the #281 setup: a diff-free PR whose head == current main can still
// trip merge-tree against an older PR. pr-old edits line1 off the original base;
// main then advances with its own line1 edit; pr-empty points at main (no commits
// of its own). merge-tree(main, pr-old) uses the original base as merge-base, so
// the two line1 edits conflict — yet pr-empty introduces no diff and must never
// report a cross-PR conflict.
beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-serialize-conflict-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "f.txt"), "line1\nline2\nline3\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  // pr-old: branch off the base and edit line1.
  git(["checkout", "-q", "-b", "pr-old"]);
  writeFileSync(join(repoPath, "f.txt"), "OLD\nline2\nline3\n");
  git(["commit", "-qam", "old"]);

  // main advances with its own line1 edit (parent = base, so merge-base of main
  // and pr-old is still the original base — their line1 edits conflict).
  git(["checkout", "-q", "main"]);
  writeFileSync(join(repoPath, "f.txt"), "MAIN\nline2\nline3\n");
  git(["commit", "-qam", "main moves"]);

  // pr-empty: head == main, no commits of its own (diff-free / commitsAhead === 0).
  git(["checkout", "-q", "-b", "pr-empty"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  svc.sessions.register({ id: "sess-1", agent: "lh-dev", session: "sess-1" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("diff-free PR reports no cross-PR conflicts; a PR with commits still does", async () => {
  const old = await svc.pulls.create(
    "me/proj",
    { title: "old", head: "pr-old", base: "main" },
    "sess-1",
  );
  const empty = await svc.pulls.create(
    "me/proj",
    { title: "empty", head: "pr-empty", base: "main" },
    "sess-1",
  );

  // pr-empty is diff-free (head == main): no conflict section despite merge-tree
  // against pr-old conflicting on f.txt. This is the #281 guard.
  const detailEmpty: any = await svc.pulls.get("me/proj", empty.number);
  expect(detailEmpty.changed_files).toBe(0);
  expect(detailEmpty.conflicts_with).toEqual([]);

  // Regression: pr-old has a commit, so its conflict fan-out still runs and sees
  // the conflicting head of pr-empty (== main) on f.txt.
  const detailOld: any = await svc.pulls.get("me/proj", old.number);
  expect(detailOld.conflicts_with.map((c: any) => c.number)).toEqual([
    empty.number,
  ]);
  expect(detailOld.conflicts_with[0].files).toContain("f.txt");
});
