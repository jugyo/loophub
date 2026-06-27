import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-conflict-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-conflict-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "f.txt"), "line1\nline2\nline3\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  // pr-a: edit line1 of f.txt.
  git(["checkout", "-q", "-b", "pr-a"]);
  writeFileSync(join(repoPath, "f.txt"), "AAA\nline2\nline3\n");
  git(["commit", "-qam", "a"]);

  // pr-b: edit the same line1 differently — conflicts with pr-a on f.txt.
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "pr-b"]);
  writeFileSync(join(repoPath, "f.txt"), "BBB\nline2\nline3\n");
  git(["commit", "-qam", "b"]);

  // pr-c: touch only an unrelated file — conflicts with nobody.
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "pr-c"]);
  writeFileSync(join(repoPath, "g.txt"), "z\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "c"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  svc.sessions.register({ id: "sess-1", agent: "lh-dev", session: "sess-1" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("pulls.get reports cross-PR conflicts with conflicting files; list omits them", async () => {
  const a = await svc.pulls.create(
    "me/proj",
    { title: "A", head: "pr-a", base: "main" },
    "sess-1",
  );
  const b = await svc.pulls.create(
    "me/proj",
    { title: "B", head: "pr-b", base: "main" },
    "sess-1",
  );
  await svc.pulls.create(
    "me/proj",
    { title: "C", head: "pr-c", base: "main" },
    "sess-1",
  );

  // PR A's detail lists B (same line of f.txt) but not C (unrelated file).
  const detailA: any = svc.pulls.get("me/proj", a.number);
  const conflictsA = (await detailA).conflicts_with;
  expect(conflictsA.map((c: any) => c.number)).toEqual([b.number]);
  expect(conflictsA[0].files).toContain("f.txt");

  // Symmetric: B's detail lists A.
  const detailB: any = await svc.pulls.get("me/proj", b.number);
  expect(detailB.conflicts_with.map((c: any) => c.number)).toEqual([a.number]);

  // The list view skips the O(n^2) conflict fan-out (field stays empty).
  const list: any[] = await svc.pulls.list("me/proj", {});
  const listA = list.find((p) => p.number === a.number);
  expect(listA.conflicts_with).toEqual([]);
});
