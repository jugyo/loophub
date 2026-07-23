import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { traceGitCommands } from "./git-trace-test-helper.ts";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "lh-prune-performance-"));
process.env.LOOPHUB_HOME = TEST_ROOT;
process.env.LOOPHUB_DB = join(TEST_ROOT, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let G: typeof import("./git.ts");
let issueNumberFromBranch: typeof import("./worktree-prune.ts").issueNumberFromBranch;

function countCommands(commands: string[], prefix: string): number {
  return commands.filter((command) => command.startsWith(prefix)).length;
}

async function makeRepo(
  name: string,
  candidateCount: number,
): Promise<{
  id: number;
  path: string;
  fixtures: Array<{ issue: number; path: string }>;
}> {
  const path = mkdtempSync(join(TEST_ROOT, "repo-"));
  await G.git(path, ["init", "-q", "-b", "main"]);
  await G.git(path, ["config", "user.email", "t@t.local"]);
  await G.git(path, ["config", "user.name", "tester"]);
  writeFileSync(join(path, "f.txt"), "base\n");
  await G.git(path, ["add", "-A"]);
  await G.git(path, ["commit", "-qm", "base"]);
  const repo = S.createRepo(name, path, "main");
  const fixtures = [];
  for (let index = 0; index < candidateCount; index++) {
    const issue = S.createIssue(
      repo.id,
      "issue",
      `candidate-${index}`,
      "",
      "me",
    );
    S.updateIssue(issue.id, { state: "closed" });
    const worktreePath = join(TEST_ROOT, `worktree-${repo.id}-${issue.number}`);
    await G.worktreeAdd(
      path,
      worktreePath,
      `loophub/issue-${issue.number}`,
      "main",
    );
    fixtures.push({ issue: issue.number, path: worktreePath });
  }
  return { id: repo.id, path, fixtures };
}

beforeAll(async () => {
  S = await import("./store.ts");
  G = await import("./git.ts");
  svc = await import("./service.ts");
  ({ issueNumberFromBranch } = await import("./worktree-prune.ts"));
}, 30_000);

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

test("representative prune fixture compares baseline and optimized high-cost operations", async () => {
  const repos = [
    await makeRepo("me/performance-a", 2),
    await makeRepo("me/performance-b", 1),
  ];

  let repoEnumerationMs = 0;
  let worktreeListingMs = 0;
  let dbLookupMs = 0;
  let statusMs = 0;
  let dbStatementCalls = 0;
  const baselinePlan = await traceGitCommands(async () => {
    let started = performance.now();
    const repoRows = S.listRepos("all");
    repoEnumerationMs = performance.now() - started;
    dbStatementCalls++;

    started = performance.now();
    const managed = [];
    for (const repo of repoRows) {
      for (const worktree of await G.worktreeList(repo.local_path)) {
        const issue = issueNumberFromBranch(worktree.branch);
        if (issue != null) managed.push({ repo, worktree, issue });
      }
    }
    worktreeListingMs = performance.now() - started;

    started = performance.now();
    for (const entry of managed) {
      const row = S.getIssue(entry.repo.id, entry.issue);
      dbStatementCalls++;
      if (row?.kind === "issue") {
        S.linkedPullForIssue(row.id);
        dbStatementCalls++;
      } else if (row) {
        S.getPull(row.id);
        dbStatementCalls++;
      }
    }
    dbLookupMs = performance.now() - started;

    started = performance.now();
    for (const entry of managed) await G.worktreeStatus(entry.worktree.path);
    statusMs = performance.now() - started;
    return managed;
  });

  const optimizedPlan = await traceGitCommands(() =>
    svc.worktrees.plan({ cwd: "/nowhere", force: true }),
  );
  expect(optimizedPlan.result).toHaveLength(3);
  expect(optimizedPlan.result.every((entry) => entry.action === "remove")).toBe(
    true,
  );

  const baselineRemoval = await traceGitCommands(async () => {
    for (const entry of optimizedPlan.result) {
      await G.worktreeList(entry.repoPath);
    }
  });
  const optimizedRemoval = await traceGitCommands(() =>
    svc.worktrees.removeMany(
      optimizedPlan.result.map((entry) => ({ ...entry, force: true })),
    ),
  );
  expect(optimizedRemoval.result.every((result) => result.removed)).toBe(true);

  const measurements = {
    fixture: {
      repositories: repos.length,
      managedWorktrees: repos.flatMap((repo) => repo.fixtures).length,
    },
    baseline: {
      elapsedMs: Math.round(baselinePlan.elapsedMs),
      repoEnumerationMs: Number(repoEnumerationMs.toFixed(3)),
      worktreeListingMs: Math.round(worktreeListingMs),
      dbLookupMs: Number(dbLookupMs.toFixed(3)),
      statusMs: Math.round(statusMs),
      dbStatementCalls,
      worktreeListCalls: countCommands(
        baselinePlan.commands,
        "worktree list --porcelain",
      ),
      statusCalls: countCommands(baselinePlan.commands, "status "),
      removalVerificationListCalls: countCommands(
        baselineRemoval.commands,
        "worktree list --porcelain",
      ),
    },
    optimized: {
      elapsedMs: Math.round(optimizedPlan.elapsedMs),
      worktreeListCalls: countCommands(
        optimizedPlan.commands,
        "worktree list --porcelain",
      ),
      statusCalls: countCommands(optimizedPlan.commands, "status "),
      removalVerificationListCalls: countCommands(
        optimizedRemoval.commands,
        "worktree list --porcelain",
      ),
    },
  };
  if (process.env.LOOPHUB_PRUNE_BENCHMARK === "1") {
    console.info(`worktree-prune measurements ${JSON.stringify(measurements)}`);
  }

  expect(measurements.fixture).toEqual({
    repositories: 2,
    managedWorktrees: 3,
  });
  expect(measurements.baseline).toMatchObject({
    dbStatementCalls: 7,
    worktreeListCalls: 2,
    statusCalls: 3,
    removalVerificationListCalls: 3,
  });
  expect(measurements.optimized).toMatchObject({
    worktreeListCalls: 2,
    statusCalls: 0,
    removalVerificationListCalls: 2,
  });
}, 30_000);
