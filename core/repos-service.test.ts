import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { git, worktreeAdd } from "./git.ts";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-repos-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

// repos.create requires a real git repo on disk; each test registers its own bare
// checkout so full_name / local_path stay unique across the file.
function initGitRepo(): string {
  const path = mkdtempSync(join(HOME, "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  return path;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("setFavorite toggles favorite, emits favorited/unfavorited events (#457)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/fav-svc" });

  const favorited = svc.repos.setFavorite("me/fav-svc", true);
  expect(favorited.favorite).toBe(true);
  expect(favorited.favorited_at).not.toBeNull();

  const unfavorited = svc.repos.setFavorite("me/fav-svc", false);
  expect(unfavorited.favorite).toBe(false);
  expect(unfavorited.favorited_at).toBeNull();
});

test("setFavorite rejects a non-boolean favorite value (#457)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/fav-svc-bad" });
  expect(() =>
    svc.repos.setFavorite("me/fav-svc-bad", "yes" as unknown as boolean),
  ).toThrow(/favorite must be a boolean/);
});

test("list sorts favorites first (#457)", async () => {
  const a = await svc.repos.create({
    path: initGitRepo(),
    name: "me/fav-svc-list-a",
  });
  const b = await svc.repos.create({
    path: initGitRepo(),
    name: "me/fav-svc-list-b",
  });
  svc.repos.setFavorite(b.full_name, true);

  const ids = svc.repos
    .list("all")
    .map((r: any) => r.id)
    .filter((id: number) => id === a.id || id === b.id);
  expect(ids).toEqual([b.id, a.id]);
});

test("rename changes owner/name, emits repo.renamed, and the old name 404s (#485)", async () => {
  const created = await svc.repos.create({
    path: initGitRepo(),
    name: "me/rn-a",
  });

  const renamed = await svc.repos.rename("me/rn-a", "acme/rn-b");
  expect(renamed.id).toBe(created.id);
  expect(renamed.full_name).toBe("acme/rn-b");

  // Name-based resolution (the same lookup `--repo owner/name` and /r/:owner/:repo use)
  // works under the new name and no longer under the old one.
  expect(svc.repos.get("acme/rn-b").id).toBe(created.id);
  expect(() => svc.repos.get("me/rn-a")).toThrow(/Not Found/);

  const ev = S.listEvents(0, created.id, 100).find(
    (e: any) => e.type === "repo.renamed",
  )!;
  expect(ev).toBeTruthy();
  expect(JSON.parse(ev.payload)).toEqual({
    full_name: "acme/rn-b",
    from: "me/rn-a",
  });
});

test("rename refuses a full_name that is already registered (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-c" });
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-d" });
  await expect(svc.repos.rename("me/rn-c", "me/rn-d")).rejects.toThrow(
    /already registered/,
  );
});

test("rename rejects malformed names (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-e" });
  await expect(svc.repos.rename("me/rn-e", "a/b/c")).rejects.toThrow(
    /invalid repo name/,
  );
  await expect(svc.repos.rename("me/rn-e", "../evil")).rejects.toThrow(
    /invalid repo name/,
  );
  await expect(svc.repos.rename("me/rn-e", "   ")).rejects.toThrow(/non-empty/);
});

test("rename to the same name is a no-op without an event (#485)", async () => {
  const created = await svc.repos.create({
    path: initGitRepo(),
    name: "me/rn-same",
  });
  const same = await svc.repos.rename("me/rn-same", "me/rn-same");
  expect(same.full_name).toBe("me/rn-same");
  const events = S.listEvents(0, created.id, 100).filter(
    (e: any) => e.type === "repo.renamed",
  );
  expect(events).toEqual([]);
});

// Worktree/dev-lock paths derive from full_name, so renaming under a live worktree would
// orphan it; the service refuses until the worktree is gone, then the rename goes through.
test("rename is refused while a worktree exists under the current name (#485)", async () => {
  const path = mkdtempSync(join(HOME, "repo-"));
  await git(path, ["init", "-q", "-b", "main"]);
  await git(path, ["config", "user.email", "t@t.local"]);
  await git(path, ["config", "user.name", "tester"]);
  writeFileSync(join(path, "f.txt"), "base\n");
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-qm", "base"]);
  await svc.repos.create({ path, name: "me/rn-busy" });

  // Same layout `lh dev` provisions: <worktreeRoot>/<full_name>/pr-<n>.
  const wt = join(HOME, "worktrees", "me", "rn-busy", "pr-1");
  await worktreeAdd(path, wt, "loophub/pr-1", "main");

  await expect(svc.repos.rename("me/rn-busy", "me/rn-idle")).rejects.toThrow(
    /cannot rename/,
  );

  await git(path, ["worktree", "remove", "--force", wt]);
  const renamed = await svc.repos.rename("me/rn-busy", "me/rn-idle");
  expect(renamed.full_name).toBe("me/rn-idle");
});

// Dev locks (<home>/dev-locks/<full_name>/pr-N.json) are claimed before the worktree is
// provisioned, so the rename guard must see them independently of `git worktree list`.
test("rename is refused while a dev lock exists under the current name (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-locked" });

  const lockDir = join(HOME, "dev-locks", "me", "rn-locked");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "pr-9.json"), "{}");

  await expect(svc.repos.rename("me/rn-locked", "me/rn-free")).rejects.toThrow(
    /dev lock/,
  );

  rmSync(join(lockDir, "pr-9.json"));
  const renamed = await svc.repos.rename("me/rn-locked", "me/rn-free");
  expect(renamed.full_name).toBe("me/rn-free");
});

// Derived worktree/dev-lock dirs live on commonly case-insensitive filesystems, so a
// case-only difference from another repo is a collision; a case-only self-rename is not.
test("rename detects case-insensitive collisions but allows case-only self-rename (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-case" });
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-other" });

  await expect(svc.repos.rename("me/rn-case", "ME/RN-OTHER")).rejects.toThrow(
    /already registered/,
  );

  const renamed = await svc.repos.rename("me/rn-case", "me/RN-Case");
  expect(renamed.full_name).toBe("me/RN-Case");
});

// A git failure (moved/deleted local_path) must refuse the rename rather than read as
// "no worktrees" and silently bypass the orphaning guard.
test("rename is refused when worktrees cannot be verified (local_path gone) (#485)", async () => {
  const path = initGitRepo();
  await svc.repos.create({ path, name: "me/rn-gone" });
  rmSync(path, { recursive: true, force: true });

  await expect(svc.repos.rename("me/rn-gone", "me/rn-still")).rejects.toThrow(
    /cannot verify worktrees/,
  );
});

// Rename edits registration metadata, like setArchived/setFavorite/setMergeMode — an
// archived repo stays renamable.
test("rename works on an archived repo (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-arch" });
  svc.repos.setArchived("me/rn-arch", true);

  const renamed = await svc.repos.rename("me/rn-arch", "me/rn-arch2");
  expect(renamed.full_name).toBe("me/rn-arch2");
  expect(renamed.archived).toBe(true);
});
