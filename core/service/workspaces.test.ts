import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-workspace-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function expect422(fn: () => unknown, message: RegExp): void {
  try {
    fn();
    throw new Error("expected ServiceError");
  } catch (error) {
    expect(error).toMatchObject({ status: 422 });
    expect((error as Error).message).toMatch(message);
  }
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-workspace-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "initial\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("workspaces.create creates a registry branch from the exact default HEAD", () => {
  const defaultHead = git(["rev-parse", "refs/heads/main"]).stdout.trim();

  const workspace = svc.workspaces.create(
    "me/proj",
    { branch: "integration/stack" },
    "session-1",
  );

  expect(workspace).toMatchObject({
    branch: "integration/stack",
    archived_at: null,
    branch_exists: true,
  });
  expect(workspace.created_at).toBeTruthy();
  expect(git(["rev-parse", "refs/heads/integration/stack"]).stdout.trim()).toBe(
    defaultHead,
  );

  const repo = S.getRepo("me", "proj");
  const event = S.listEvents(0, repo?.id ?? null, 100).find(
    (candidate) => candidate.type === "workspace.created",
  );
  expect(event && JSON.parse(event.payload)).toEqual({
    branch: "integration/stack",
  });
});

test("workspaces.create rejects invalid and default branch names with 422", () => {
  expect422(
    () => svc.workspaces.create("me/proj", { branch: "bad branch" }),
    /workspace branch must be a local branch name/,
  );
  expect422(
    () => svc.workspaces.create("me/proj", { branch: "bad\0branch" }),
    /workspace branch must be a local branch name/,
  );
  expect422(
    () => svc.workspaces.create("me/proj", { branch: "main" }),
    /must differ from the default branch/,
  );
});

test("workspaces.create rejects a registered branch with 422", () => {
  svc.workspaces.create("me/proj", { branch: "registered/duplicate" });

  expect422(
    () => svc.workspaces.create("me/proj", { branch: "registered/duplicate" }),
    /workspace already registered/,
  );
});

test("workspaces.create rejects an existing unregistered branch with 422", () => {
  git(["branch", "existing/branch", "main"]);

  expect422(
    () => svc.workspaces.create("me/proj", { branch: "existing/branch" }),
    /workspace branch already exists/,
  );

  const repo = S.getRepo("me", "proj");
  expect(S.getWorkspace(repo?.id ?? 0, "existing/branch")).toBeNull();
});

test("workspaces.create reports git failures as 422", () => {
  git(["branch", "blocking-prefix", "main"]);

  expect422(
    () =>
      svc.workspaces.create("me/proj", {
        branch: "blocking-prefix/workspace",
      }),
    /failed to create workspace branch/,
  );
});

test("workspaces.list reports a deleted registry branch as missing", () => {
  svc.workspaces.create("me/proj", { branch: "deleted/externally" });
  git(["branch", "-D", "deleted/externally"]);

  expect(svc.workspaces.list("me/proj")).toContainEqual(
    expect.objectContaining({
      branch: "deleted/externally",
      branch_exists: false,
    }),
  );
});

test("workspaces.listUnmerged selects active existing non-default branches ahead of default", async () => {
  const repo = S.getRepo("me", "proj")!;
  S.createWorkspace(repo.id, "main");

  svc.workspaces.create("me/proj", { branch: "unmerged/first" });
  git(["checkout", "-q", "unmerged/first"]);
  writeFileSync(join(repoPath, "first.txt"), "first\n");
  git(["add", "first.txt"]);
  git(["commit", "-qm", "first workspace commit"]);
  git(["checkout", "-q", "main"]);

  svc.workspaces.create("me/proj", { branch: "unmerged/second" });
  git(["checkout", "-q", "unmerged/second"]);
  writeFileSync(join(repoPath, "second.txt"), "second\n");
  git(["add", "second.txt"]);
  git(["commit", "-qm", "second workspace commit"]);
  git(["checkout", "-q", "main"]);

  // Regular merge: workspace commits become ancestors of main (rev-list count is 0).
  svc.workspaces.create("me/proj", { branch: "merged/already" });
  git(["checkout", "-q", "merged/already"]);
  writeFileSync(join(repoPath, "merged.txt"), "merged\n");
  git(["add", "merged.txt"]);
  git(["commit", "-qm", "merged workspace commit"]);
  git(["checkout", "-q", "main"]);
  git(["merge", "--no-ff", "-qm", "merge workspace", "merged/already"]);

  // Squash merge of multiple commits: ancestry still reports commits ahead, but
  // default's tree already includes the same content, so listUnmerged must hide it.
  svc.workspaces.create("me/proj", { branch: "merged/squash" });
  git(["checkout", "-q", "merged/squash"]);
  writeFileSync(join(repoPath, "squash1.txt"), "squash1\n");
  git(["add", "squash1.txt"]);
  git(["commit", "-qm", "squash workspace commit 1"]);
  writeFileSync(join(repoPath, "squash2.txt"), "squash2\n");
  git(["add", "squash2.txt"]);
  git(["commit", "-qm", "squash workspace commit 2"]);
  git(["checkout", "-q", "main"]);
  expect(git(["merge", "--squash", "merged/squash"]).status).toBe(0);
  expect(git(["commit", "-qm", "squash merge workspace"]).status).toBe(0);
  // Sanity: ancestry still sees unique SHAs on the workspace tip.
  expect(
    Number(
      git(["rev-list", "--count", "refs/heads/main..refs/heads/merged/squash"])
        .stdout,
    ),
  ).toBeGreaterThan(0);

  // Squash-landed work plus a later default rewrite of a shared file: merge-tree
  // conflicts, but there is no net-new workspace content — hide it (opencode-shaped).
  writeFileSync(join(repoPath, "README.md"), "base readme\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "add readme base"]);
  svc.workspaces.create("me/proj", { branch: "merged/stale-conflict" });
  git(["checkout", "-q", "merged/stale-conflict"]);
  writeFileSync(join(repoPath, "landed.txt"), "landed\n");
  git(["add", "landed.txt"]);
  git(["commit", "-qm", "landed feature"]);
  writeFileSync(join(repoPath, "README.md"), "workspace readme\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "workspace readme edit"]);
  git(["checkout", "-q", "main"]);
  expect(git(["merge", "--squash", "merged/stale-conflict"]).status).toBe(0);
  expect(git(["commit", "-qm", "squash stale-conflict workspace"]).status).toBe(
    0,
  );
  writeFileSync(join(repoPath, "README.md"), "main readme rewrite\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "main rewrites readme after squash"]);
  expect(
    git([
      "merge-tree",
      "--write-tree",
      "refs/heads/main",
      "refs/heads/merged/stale-conflict",
    ]).status,
  ).not.toBe(0);

  // Same conflict shape, but the workspace still has a unique file → keep listing it.
  svc.workspaces.create("me/proj", { branch: "unmerged/conflict-plus" });
  git(["branch", "-f", "unmerged/conflict-plus", "merged/stale-conflict"]);
  git(["checkout", "-q", "unmerged/conflict-plus"]);
  writeFileSync(join(repoPath, "still-open.txt"), "still open\n");
  git(["add", "still-open.txt"]);
  git(["commit", "-qm", "unique leftover work"]);
  git(["checkout", "-q", "main"]);

  svc.workspaces.create("me/proj", { branch: "missing/ahead" });
  git(["branch", "-D", "missing/ahead"]);

  svc.workspaces.create("me/proj", { branch: "archived/ahead" });
  git(["checkout", "-q", "archived/ahead"]);
  writeFileSync(join(repoPath, "archived.txt"), "archived\n");
  git(["add", "archived.txt"]);
  git(["commit", "-qm", "archived workspace commit"]);
  git(["checkout", "-q", "main"]);
  svc.workspaces.archive("me/proj", "archived/ahead");

  git(["tag", "main", "refs/heads/main"]);
  git(["tag", "unmerged/first", "refs/heads/main"]);

  expect(await svc.workspaces.listUnmerged("me/proj")).toEqual([
    expect.objectContaining({
      branch: "unmerged/first",
      archived_at: null,
      branch_exists: true,
    }),
    expect.objectContaining({
      branch: "unmerged/second",
      archived_at: null,
      branch_exists: true,
    }),
    expect.objectContaining({
      branch: "unmerged/conflict-plus",
      archived_at: null,
      branch_exists: true,
    }),
  ]);

  git(["branch", "-m", "main", "default/temporarily-missing"]);
  try {
    await expect(svc.workspaces.listUnmerged("me/proj")).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("failed to compare workspace branch"),
    });
  } finally {
    git(["branch", "-m", "default/temporarily-missing", "main"]);
  }
});

test("settings lists exclude the default branch without changing generic lists", () => {
  const repo = S.getRepo("me", "proj")!;
  S.getWorkspace(repo.id, repo.default_branch) ??
    S.createWorkspace(repo.id, repo.default_branch);

  expect(svc.workspaces.list("me/proj")).toContainEqual(
    expect.objectContaining({ branch: repo.default_branch }),
  );
  expect(svc.workspaces.listForSettings("me/proj")).not.toContainEqual(
    expect.objectContaining({ branch: repo.default_branch }),
  );

  S.setWorkspaceArchived(repo.id, repo.default_branch, true);
  expect(svc.workspaces.listArchived("me/proj")).toContainEqual(
    expect.objectContaining({ branch: repo.default_branch }),
  );
  expect(svc.workspaces.listArchivedForSettings("me/proj")).not.toContainEqual(
    expect.objectContaining({ branch: repo.default_branch }),
  );
});

test("workspaces archive and unarchive only change the registry and emit events", () => {
  svc.workspaces.create("me/proj", { branch: "archive/me" });

  const archived = svc.workspaces.archive("me/proj", "archive/me");
  expect(archived.archived_at).toBeTruthy();
  expect(archived.branch_exists).toBe(true);
  expect(svc.workspaces.listArchived("me/proj")).toContainEqual(
    expect.objectContaining({ branch: "archive/me" }),
  );
  expect(svc.workspaces.list("me/proj")).not.toContainEqual(
    expect.objectContaining({ branch: "archive/me" }),
  );
  expect(git(["show-ref", "--verify", "refs/heads/archive/me"]).status).toBe(0);
  expect422(
    () => svc.workspaces.create("me/proj", { branch: "archive/me" }),
    /workspace already registered/,
  );

  const unarchived = svc.workspaces.unarchive("me/proj", "archive/me");
  expect(unarchived.archived_at).toBeNull();
  expect(svc.workspaces.listArchived("me/proj")).not.toContainEqual(
    expect.objectContaining({ branch: "archive/me" }),
  );
  expect(svc.workspaces.list("me/proj")).toContainEqual(
    expect.objectContaining({ branch: "archive/me", branch_exists: true }),
  );

  const repo = S.getRepo("me", "proj");
  const workspaceEvents = S.listEvents(0, repo?.id ?? null, 100)
    .filter((event) => event.type.startsWith("workspace."))
    .map((event) => ({ type: event.type, payload: JSON.parse(event.payload) }));
  expect(workspaceEvents).toEqual(
    expect.arrayContaining([
      { type: "workspace.archived", payload: { branch: "archive/me" } },
      { type: "workspace.unarchived", payload: { branch: "archive/me" } },
    ]),
  );
});
