import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-repos-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");

// repos.create requires a real git repo on disk; each test registers its own bare
// checkout so full_name / local_path stay unique across the file.
function initGitRepo(): string {
  const path = mkdtempSync(join(HOME, "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  return path;
}

beforeAll(async () => {
  svc = await import("./service.ts");
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
