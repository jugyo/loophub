import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

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
