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
let D: typeof import("./db.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  D = await import("./db.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-issue-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["branch", "integration/stack"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("issues.get returns comment bodies in comment_list (#231)", async () => {
  const issue = svc.issues.create("me/proj", { title: "t", body: "body" });
  svc.comments.create("me/proj", issue.number, "first design note", "sess-a");
  svc.comments.create("me/proj", issue.number, "second design note", "sess-b");

  const detail = (await svc.issues.get("me/proj", issue.number)) as any;

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

test("issues.get returns an empty comment_list when there are no comments", async () => {
  const issue = svc.issues.create("me/proj", { title: "no comments" });
  const detail = (await svc.issues.get("me/proj", issue.number)) as any;
  expect(detail.comments).toBe(0);
  expect(detail.comment_list).toEqual([]);
});

test("issues.create stores and exposes a target branch", async () => {
  const issue = svc.issues.create("me/proj", {
    title: "branch-targeted",
    target_branch: "integration/stack",
  }) as any;

  expect(issue.target_branch).toBe("integration/stack");
  const detail = (await svc.issues.get("me/proj", issue.number)) as any;
  expect(detail.target_branch).toBe("integration/stack");
});

test("issues.create normalizes a blank target branch to null", () => {
  const issue = svc.issues.create("me/proj", {
    title: "blank target",
    target_branch: "   ",
  }) as any;

  expect(issue.target_branch).toBeNull();
});

test("issues.create without a target branch does not create a branch", () => {
  const before = git([
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/new/topic",
  ]);
  expect(before.status).not.toBe(0);

  const issue = svc.issues.create("me/proj", {
    title: "untargeted",
  }) as any;

  expect(issue.target_branch).toBeNull();
  const after = git([
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/new/topic",
  ]);
  expect(after.status).not.toBe(0);
});

test("issues.create can create a missing target branch from default", () => {
  const issue = svc.issues.create("me/proj", {
    title: "new target",
    target_branch: "feature/new-target",
    create_target_branch: true,
  }) as any;

  expect(issue.target_branch).toBe("feature/new-target");
  expect(
    git(["show-ref", "--verify", "--quiet", "refs/heads/feature/new-target"])
      .status,
  ).toBe(0);
});

test("issues.create creates missing target branch from the exact default branch ref", () => {
  writeFileSync(join(repoPath, "default-only.txt"), "default\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "default-only"]);
  const defaultHead = git(["rev-parse", "refs/heads/main"]).stdout.trim();
  const previousCommit = git(["rev-parse", "main~1"]).stdout.trim();
  git(["tag", "main", previousCommit]);

  const issue = svc.issues.create("me/proj", {
    title: "ambiguous default target",
    target_branch: "feature/ambiguous-default",
    create_target_branch: true,
  }) as any;

  expect(issue.target_branch).toBe("feature/ambiguous-default");
  expect(git(["rev-parse", "feature/ambiguous-default"]).stdout.trim()).toBe(
    defaultHead,
  );
  git(["tag", "-d", "main"]);
});

test("issues.create rejects a missing target branch", () => {
  expect(() =>
    svc.issues.create("me/proj", {
      title: "missing target",
      target_branch: "missing/stack",
    }),
  ).toThrow(/target_branch must name an existing local branch/);
});

test("issues.create rejects option-like target branches", () => {
  expect(() =>
    svc.issues.create("me/proj", {
      title: "option target",
      target_branch: "--output=/tmp/lh-target-branch",
    }),
  ).toThrow(/target_branch must be a local branch name/);
});

test("issues.create rejects revision-special target branch names", () => {
  git(["branch", "@"]);

  expect(() =>
    svc.issues.create("me/proj", {
      title: "special target",
      target_branch: "@",
    }),
  ).toThrow(/target_branch must be a local branch name/);

  expect(() =>
    svc.issues.create("me/proj", {
      title: "special new target",
      target_branch: "HEAD",
      create_target_branch: true,
    }),
  ).toThrow(/target_branch must be a local branch name/);
});

test("issues.create rejects invalid target branches before create-if-missing", () => {
  expect(() =>
    svc.issues.create("me/proj", {
      title: "invalid target",
      target_branch: "--output=/tmp/lh-target-branch",
      create_target_branch: true,
    }),
  ).toThrow(/target_branch must be a local branch name/);
});

test("issues.create rejects revision expressions before create-if-missing", () => {
  expect(() =>
    svc.issues.create("me/proj", {
      title: "revision target",
      target_branch: "main~1",
      create_target_branch: true,
    }),
  ).toThrow(/target_branch must be a local branch name/);
});

test("issues.create fails before creating the issue when default branch is missing", () => {
  const repo = S.createRepo("me/missing-default", repoPath, "missing-default");
  const before = S.listIssues(repo.id, "issue", "open", "created").length;

  expect(() =>
    svc.issues.create("me/missing-default", {
      title: "cannot create branch",
      target_branch: "feature/from-missing-default",
      create_target_branch: true,
    }),
  ).toThrow(/cannot resolve default branch "missing-default"/);

  expect(S.listIssues(repo.id, "issue", "open", "created")).toHaveLength(
    before,
  );
  expect(
    git([
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/feature/from-missing-default",
    ]).status,
  ).not.toBe(0);
});

test("issues.list defaults to newest-created order and keeps label filters (#751)", async () => {
  const repo = S.createRepo("me/list-default-sort", "/tmp/list-default-sort");
  const oldIssue = S.createIssue(
    repo.id,
    "issue",
    "old labeled",
    "",
    "me",
  ) as any;
  const newIssue = S.createIssue(
    repo.id,
    "issue",
    "new labeled",
    "",
    "me",
  ) as any;
  const newestUnlabeled = S.createIssue(
    repo.id,
    "issue",
    "newest unlabeled",
    "",
    "me",
  ) as any;
  const setTimes = (id: number, created: string, updated: string) =>
    D.db.run("UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?", [
      created,
      updated,
      id,
    ]);

  setTimes(oldIssue.id, "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z");
  setTimes(newIssue.id, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
  setTimes(newestUnlabeled.id, "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
  S.addLabels(repo.id, oldIssue.id, ["ready-to-build"]);
  S.addLabels(repo.id, newIssue.id, ["ready-to-build"]);

  const defaults = (await svc.issues.list("me/list-default-sort", {
    kind: "issue",
    state: "open",
  })) as any[];
  const filtered = (await svc.issues.list("me/list-default-sort", {
    kind: "issue",
    state: "open",
    labels: ["ready-to-build"],
  })) as any[];
  const updated = (await svc.issues.list("me/list-default-sort", {
    kind: "issue",
    state: "open",
    sort: "updated",
  })) as any[];

  expect(defaults.map((issue) => issue.title)).toEqual([
    "newest unlabeled",
    "new labeled",
    "old labeled",
  ]);
  expect(filtered.map((issue) => issue.title)).toEqual([
    "new labeled",
    "old labeled",
  ]);
  expect(updated.map((issue) => issue.title)).toEqual([
    "old labeled",
    "newest unlabeled",
    "new labeled",
  ]);
});

test("issues.list advances lookahead pages by the visible issue-list size (#906)", async () => {
  const repo = S.createRepo("me/list-lookahead", "/tmp/list-lookahead");
  for (let i = 1; i <= 201; i += 1) {
    S.createIssue(repo.id, "issue", `lookahead ${i}`, "", "me");
  }

  const page1 = (await svc.issues.list("me/list-lookahead", {
    kind: "issue",
    state: "open",
    perPage: 101,
    page: 1,
  })) as any[];
  const page2 = (await svc.issues.list("me/list-lookahead", {
    kind: "issue",
    state: "open",
    perPage: 101,
    page: 2,
  })) as any[];
  const page3 = (await svc.issues.list("me/list-lookahead", {
    kind: "issue",
    state: "open",
    perPage: 101,
    page: 3,
  })) as any[];

  expect(page1).toHaveLength(101);
  expect(page2).toHaveLength(101);
  expect(page3).toHaveLength(1);
});

test("issues.create links a New Issue Herdr pane through the launch id (#670)", async () => {
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

    const detail = (await svc.issues.get("me/proj", issue.number)) as any;
    expect(detail.herdr_pane).toMatchObject({
      launch_id: "launch-670",
      pane_id: "w4:p2",
      session_name: "me-proj-12345678",
    });

    const list = (await svc.issues.list("me/proj", {
      kind: "issue",
      state: "open",
    })) as any[];
    expect(
      list.find((item) => item.number === issue.number)?.herdr_pane,
    ).toMatchObject({
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

test("New Issue launch lookup is scoped to its repository", () => {
  const firstRepo = S.getRepo("me", "proj");
  if (!firstRepo) throw new Error("repo missing");
  const secondRepo = S.createRepo("me/other-panes", "/tmp/other-panes");

  S.upsertIssueHerdrPane({
    launchId: "shared-launch",
    repoId: firstRepo.id,
    paneId: "w1:p1",
  });
  S.upsertIssueHerdrPane({
    launchId: "shared-launch",
    repoId: secondRepo.id,
    paneId: "w2:p2",
  });

  expect(
    S.getIssueHerdrPaneByLaunch(secondRepo.id, "shared-launch")?.pane_id,
  ).toBe("w2:p2");
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
