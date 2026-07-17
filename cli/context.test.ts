import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { worktreePath } from "../core/worktree-path.ts";

const originalCwd = process.cwd();
const originalHome = process.env.LOOPHUB_HOME;
const originalDb = process.env.LOOPHUB_DB;
const originalRepo = process.env.LOOPHUB_REPO;
const home = mkdtempSync(join(tmpdir(), "lh-context-"));
const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "lh-context-repo-")));

process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "loophub.db");

let flags: typeof import("./args.ts").flags;
let resolveRepo: typeof import("./context.ts").resolveRepo;

beforeAll(async () => {
  execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
  ({ flags } = await import("./args.ts"));
  ({ resolveRepo } = await import("./context.ts"));
  const { repos } = await import("../core/service.ts");
  await repos.create({ path: repoPath, name: "me/cwd-repo" });
});

beforeEach(() => {
  delete flags.repo;
  delete process.env.LOOPHUB_REPO;
  process.chdir(originalCwd);
});

afterAll(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.LOOPHUB_HOME;
  else process.env.LOOPHUB_HOME = originalHome;
  if (originalDb === undefined) delete process.env.LOOPHUB_DB;
  else process.env.LOOPHUB_DB = originalDb;
  if (originalRepo === undefined) delete process.env.LOOPHUB_REPO;
  else process.env.LOOPHUB_REPO = originalRepo;
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("resolveRepo falls back to LOOPHUB_REPO outside a registered repo root", async () => {
  process.env.LOOPHUB_REPO = "me/env-repo";

  await expect(resolveRepo()).resolves.toBe("me/env-repo");
});

test("resolveRepo prefers --repo over LOOPHUB_REPO", async () => {
  flags.repo = "me/flag-repo";
  process.env.LOOPHUB_REPO = "me/env-repo";

  await expect(resolveRepo()).resolves.toBe("me/flag-repo");
});

test("resolveRepo still falls back to the cwd match", async () => {
  process.chdir(repoPath);

  await expect(resolveRepo()).resolves.toBe("me/cwd-repo");
});

test("resolveRepo infers a registered repo from a LoopHub worktree cwd", async () => {
  const wt = worktreePath(join(home, "worktrees"), "me/cwd-repo", 42);
  mkdirSync(wt, { recursive: true });
  process.chdir(wt);

  await expect(resolveRepo()).resolves.toBe("me/cwd-repo");
});

test("resolveRepo prefers --repo over worktree cwd inference", async () => {
  flags.repo = "me/flag-repo";
  const wt = worktreePath(join(home, "worktrees"), "me/cwd-repo", 43);
  mkdirSync(wt, { recursive: true });
  process.chdir(wt);

  await expect(resolveRepo()).resolves.toBe("me/flag-repo");
});

test("resolveRepo prefers LOOPHUB_REPO over worktree cwd inference", async () => {
  process.env.LOOPHUB_REPO = "me/env-repo";
  const wt = worktreePath(join(home, "worktrees"), "me/cwd-repo", 44);
  mkdirSync(wt, { recursive: true });
  process.chdir(wt);

  await expect(resolveRepo()).resolves.toBe("me/env-repo");
});

test("resolveRepo rejects a worktree path for an unregistered owner/name", async () => {
  const wt = worktreePath(join(home, "worktrees"), "other/unregistered", 1);
  mkdirSync(wt, { recursive: true });
  process.chdir(wt);

  const exit = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit ${code ?? 0}`);
  }) as never);
  const err = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(resolveRepo()).rejects.toThrow(/exit 1/);
  expect(err).toHaveBeenCalledWith(
    expect.stringContaining("Cannot determine the repo"),
  );

  exit.mockRestore();
  err.mockRestore();
});

test("resolveRepo still fails outside any registered root or worktree", async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "lh-context-elsewhere-"));
  try {
    process.chdir(elsewhere);

    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit ${code ?? 0}`);
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(resolveRepo()).rejects.toThrow(/exit 1/);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("Cannot determine the repo"),
    );

    exit.mockRestore();
    err.mockRestore();
  } finally {
    process.chdir(originalCwd);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
