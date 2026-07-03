import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ENV_ISSUE_CREATE_HERDR_LAUNCH } from "./resume.ts";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-issue-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-issue-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("issues.get returns comment bodies in comment_list (#231)", () => {
  const issue = svc.issues.create("me/proj", { title: "t", body: "body" });
  svc.comments.create("me/proj", issue.number, "first design note", "sess-a");
  svc.comments.create("me/proj", issue.number, "second design note", "sess-b");

  const detail = svc.issues.get("me/proj", issue.number) as any;

  // Count stays for the cheap summary surface...
  expect(detail.comments).toBe(2);
  // ...and the detail also carries the full bodies (author, time, text). Assert membership, not
  // order: comments created within the same second share a `created_at` (now() drops sub-second
  // precision) and listComments orders by created_at with no tiebreaker, so order is not guaranteed.
  expect(detail.comment_list).toHaveLength(2);
  expect(detail.comment_list.map((c: any) => c.body)).toEqual(
    expect.arrayContaining(["first design note", "second design note"]),
  );
  const [c0] = detail.comment_list;
  expect(c0.user.login).toBeTruthy();
  expect(c0.created_at).toBeTruthy();
});

test("issues.get returns an empty comment_list when there are no comments", () => {
  const issue = svc.issues.create("me/proj", { title: "no comments" });
  const detail = svc.issues.get("me/proj", issue.number) as any;
  expect(detail.comments).toBe(0);
  expect(detail.comment_list).toEqual([]);
});

test("issues.create links a New Issue Herdr pane through the launch id (#670)", () => {
  const repo = S.getRepo("me", "proj");
  if (!repo) throw new Error("repo missing");
  const previous = process.env[ENV_ISSUE_CREATE_HERDR_LAUNCH];
  process.env[ENV_ISSUE_CREATE_HERDR_LAUNCH] = "launch-670";
  try {
    const issue = svc.issues.create("me/proj", { title: "from herdr" });
    S.upsertIssueHerdrPane({
      launchId: "launch-670",
      repoId: repo.id,
      paneId: "w4:p2",
      sessionName: "me-proj-12345678",
    });

    const detail = svc.issues.get("me/proj", issue.number) as any;
    expect(detail.herdr_pane).toMatchObject({
      launch_id: "launch-670",
      pane_id: "w4:p2",
      session_name: "me-proj-12345678",
    });
  } finally {
    if (previous === undefined)
      delete process.env[ENV_ISSUE_CREATE_HERDR_LAUNCH];
    else process.env[ENV_ISSUE_CREATE_HERDR_LAUNCH] = previous;
  }
});

test("repos.remove removes Herdr pane links even when issue_id is not assigned yet", () => {
  const repo = S.getRepo("me", "proj");
  if (!repo) throw new Error("repo missing");
  S.upsertIssueHerdrPane({
    launchId: "launch-no-issue",
    repoId: repo.id,
    paneId: "w4:p9",
    sessionName: "me-proj-no-issue",
  });

  svc.repos.remove("me/proj");

  expect(S.getRepo("me", "proj")).toBeNull();
});
