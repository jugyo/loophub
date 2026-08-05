import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-merge-author-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

// "<author name> <author email>|<committer name> <committer email>" of a commit.
function identityOf(ref: string): string {
  return git(["show", "-s", "--format=%an <%ae>|%cn <%ce>", ref]).stdout.trim();
}

// A branch off main with one commit, ready to be merged.
function makeBranch(branch: string, file: string) {
  git(["checkout", "-q", "-b", branch, "main"]);
  writeFileSync(join(repoPath, file), `${file}\n`);
  git(["add", "-A"]);
  git(["commit", "-qm", `add ${file}`]);
  git(["checkout", "-q", "main"]);
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-merge-author-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "a\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

// #2389: a human merging from the Web UI has no session, and the merge commit must carry the
// repository's configured identity rather than a placeholder LoopHub invents.
test("merge() without a session authors the commit as the repository's git config user", async () => {
  makeBranch("loophub/human", "human.txt");
  const pr = (await svc.pulls.create(
    "me/proj",
    { title: "human merge", head: "loophub/human", base: "main" },
    undefined,
  )) as any;

  const res = (await svc.pulls.merge(
    "me/proj",
    pr.number,
    "merge",
    undefined,
  )) as any;
  expect(res.merged).toBe(true);
  expect(identityOf(res.sha)).toBe("tester <t@t.local>|tester <t@t.local>");
});

// A merge performed by an agent session keeps naming that session, so existing history and any
// author-scoped reading of it are unchanged.
test("merge() with a session keeps authoring the commit as that session's agent", async () => {
  S.registerAgentSession("sess-merge-1", "executor", "ext-merge-1");
  makeBranch("loophub/agent", "agent.txt");
  const pr = (await svc.pulls.create(
    "me/proj",
    { title: "agent merge", head: "loophub/agent", base: "main" },
    undefined,
  )) as any;

  const res = (await svc.pulls.merge(
    "me/proj",
    pr.number,
    "merge",
    "sess-merge-1",
  )) as any;
  expect(res.merged).toBe(true);
  expect(identityOf(res.sha)).toBe(
    "executor <executor@loophub.local>|executor <executor@loophub.local>",
  );
});
