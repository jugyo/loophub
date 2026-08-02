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

test("settings lists exclude the default branch without changing generic lists", () => {
  const repo = S.getRepo("me", "proj")!;
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
