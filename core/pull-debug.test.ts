import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-pull-debug-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-pull-debug-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "f.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);

  // A feature branch with one commit over main, so the debug dump has real git facts.
  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repoPath, "f.txt"), "changed\n");
  git(["commit", "-qam", "feature change"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  svc.sessions.register({ id: "sess-1", agent: "lh-dev", session: "sess-1" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("pulls.debug aggregates raw rows, git facts, notes, and events for a PR", async () => {
  const issue = svc.issues.create(
    "me/proj",
    { title: "the issue", body: "do the thing" },
    "sess-1",
  );
  const pr = await svc.pulls.create(
    "me/proj",
    {
      title: "the PR",
      body: `implements it\n\nCloses #${issue.number}`,
      head: "feature",
      base: "main",
      issue: issue.number,
    },
    "sess-1",
  );

  // A dev note (dev.note event) and a review note for this PR, so the dump's note/event
  // sections are non-empty.
  svc.dev.note(
    "me/proj",
    { kind: "decision", summary: "chose X", pr: pr.number },
    "sess-1",
  );
  await svc.reviewNotes.create(
    "me/proj",
    { path: "f.txt", body: "edits f.txt", pr: pr.number },
    "sess-1",
  );

  const dump: any = await svc.pulls.debug("me/proj", pr.number);

  // Raw DB rows.
  expect(dump.repo.full_name).toBe("me/proj");
  expect(dump.issue_row.number).toBe(pr.number);
  expect(dump.issue_row.kind).toBe("pull");
  expect(dump.pull_row.head_ref).toBe("feature");
  expect(dump.pull_row.base_ref).toBe("main");
  expect(dump.linked_issue_row.number).toBe(issue.number);

  // git facts: resolved SHAs, one commit ahead, the changed file.
  expect(dump.git.head_sha).toMatch(/^[0-9a-f]{40}$/);
  expect(dump.git.base_sha).toMatch(/^[0-9a-f]{40}$/);
  expect(dump.git.commits_ahead).toBe(1);
  expect(dump.git.commits.map((c: any) => c.subject)).toContain(
    "feature change",
  );
  expect(dump.git.files.map((f: any) => f.filename)).toContain("f.txt");
  expect(dump.git.diffstat.changedFiles).toBe(1);

  // Notes + events.
  expect(dump.review_notes.some((n: any) => n.path === "f.txt")).toBe(true);
  const types = dump.events.map((e: any) => e.type);
  expect(types).toContain("pull_request.opened");
  expect(types).toContain("dev.note");

  // Dev session attribution carried through.
  expect(dump.session?.id).toBe("sess-1");
});

test("pulls.debug 404s for a missing PR", async () => {
  await expect(svc.pulls.debug("me/proj", 999)).rejects.toMatchObject({
    status: 404,
  });
});
