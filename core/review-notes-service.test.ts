import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-rn-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function makePull(): Promise<number> {
  const issue = svc.issues.create("me/proj", { title: "feature" });
  const pr = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, head: "main", base: "main" },
    "sess-1",
  );
  return pr.number;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-rn-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  svc.sessions.register({ id: "sess-1", agent: "lh-dev", session: "sess-1" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("create defaults the diff range to the PR's base/head SHAs", async () => {
  const number = await makePull();
  const headSha = git(["rev-parse", "main"]).stdout.trim();

  const note = await svc.reviewNotes.create(
    "me/proj",
    number,
    { path: "a.txt", body: "what/why/review-points" },
    "sess-1",
  );
  expect(note.path).toBe("a.txt");
  expect(note.commit_sha).toBe(headSha);
  expect(note.base_sha).toBe(headSha); // head == base in this minimal PR
  expect(note.pull_request).toEqual({ number });

  const listed = svc.reviewNotes.list("me/proj", number);
  expect(listed.map((n: any) => n.id)).toContain(note.id);
});

test("create accepts an explicit pinned diff range", async () => {
  const number = await makePull();
  const note = await svc.reviewNotes.create(
    "me/proj",
    number,
    { path: "a.txt", body: "pinned", baseSha: "base999", commitSha: "head999" },
    "sess-1",
  );
  expect(note.base_sha).toBe("base999");
  expect(note.commit_sha).toBe("head999");
});

test("list filters by path and commit; get/update/delete by id", async () => {
  const number = await makePull();
  const n1 = await svc.reviewNotes.create(
    "me/proj",
    number,
    { path: "a.txt", body: "one", baseSha: "b", commitSha: "c1" },
    "sess-1",
  );
  await svc.reviewNotes.create(
    "me/proj",
    number,
    { path: "b.txt", body: "two", baseSha: "b", commitSha: "c2" },
    "sess-1",
  );

  expect(
    svc.reviewNotes.list("me/proj", number, { path: "a.txt" }).length,
  ).toBe(1);
  expect(svc.reviewNotes.list("me/proj", number, { commit: "c2" }).length).toBe(
    1,
  );

  expect(svc.reviewNotes.get("me/proj", n1.id).body).toBe("one");

  const edited = svc.reviewNotes.update(
    "me/proj",
    n1.id,
    "one-edited",
    "sess-1",
  );
  expect(edited.body).toBe("one-edited");

  svc.reviewNotes.remove("me/proj", n1.id, "sess-1");
  expect(() => svc.reviewNotes.get("me/proj", n1.id)).toThrow();
});

test("create validates path and body, and 404s for a missing PR", async () => {
  const number = await makePull();
  await expect(
    svc.reviewNotes.create(
      "me/proj",
      number,
      { path: "", body: "x" },
      "sess-1",
    ),
  ).rejects.toThrow();
  await expect(
    svc.reviewNotes.create(
      "me/proj",
      number,
      { path: "a.txt", body: "" },
      "sess-1",
    ),
  ).rejects.toThrow();
  await expect(
    svc.reviewNotes.create(
      "me/proj",
      99999,
      { path: "a.txt", body: "x" },
      "sess-1",
    ),
  ).rejects.toThrow();
});
