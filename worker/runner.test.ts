import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { git, worktreeAdd } from "../core/git.ts";
import { WORKFLOW_PATH } from "../core/workflow.ts";

// Isolate HOME/DB before db.ts runs its import-time setup (see AGENTS.md test convention).
const HOME = mkdtempSync(join(tmpdir(), "lh-worker-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("../core/store.ts");
let R: typeof import("./runner.ts");

// Init a git repo whose working tree is the repo's local_path, with a workflow.yml.
async function makeRepo(workflowYml: string): Promise<string> {
  const p = mkdtempSync(join(tmpdir(), "lh-repo-"));
  await git(p, ["init", "-q", "-b", "main"]);
  await git(p, ["config", "user.email", "t@t.local"]);
  await git(p, ["config", "user.name", "tester"]);
  writeFileSync(join(p, "f.txt"), "base\n");
  await git(p, ["add", "-A"]);
  await git(p, ["commit", "-qm", "base"]);
  mkdirSync(join(p, ".loophub"), { recursive: true });
  writeFileSync(join(p, WORKFLOW_PATH), workflowYml);
  return p;
}

beforeAll(async () => {
  S = await import("../core/store.ts");
  R = await import("./runner.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("issue.opened runs steps in repo cwd with LH_* env; a failing step does not stop the rest", async () => {
  const repoPath = await makeRepo(
    [
      "on:",
      "  issue.opened:",
      '    - run: printf "%s|%s|%s" "$LH_EVENT_TYPE" "$LH_REPO" "$LH_ISSUE_NUMBER" > env.out',
      "    - run: exit 3", // failing step in the middle
      "    - run: touch after-failure.out", // must still run
      "",
    ].join("\n"),
  );
  const repo = S.createRepo("jugyo/wf-issue", repoPath);
  const issue = S.createIssue(repo.id, "issue", "hi", "", "me") as any;
  const row = S.emitEvent(repo.id, "issue.opened", "me", {
    number: issue.number,
  });

  await R.dispatchEvent(row);

  // cwd was the repo's local_path and the env was populated.
  expect(readFileSync(join(repoPath, "env.out"), "utf8")).toBe(
    `issue.opened|jugyo/wf-issue|${issue.number}`,
  );
  // The step after the failing one still ran.
  expect(existsSync(join(repoPath, "after-failure.out"))).toBe(true);

  // run_started/run_completed pairs were emitted for all three steps, with the failure recorded.
  const events = S.listEvents(row.id, repo.id, 100);
  const started = events.filter((e: any) => e.type === "workflow.run_started");
  const completed = events.filter(
    (e: any) => e.type === "workflow.run_completed",
  );
  expect(started.length).toBe(3);
  expect(completed.length).toBe(3);
  const codes = completed.map((e: any) => JSON.parse(e.payload).exit_code);
  expect(codes).toEqual([0, 3, 0]);

  // Full output is captured to the per-event log file.
  const logFile = JSON.parse(completed[0].payload).log;
  expect(existsSync(logFile)).toBe(true);

  rmSync(repoPath, { recursive: true, force: true });
});

test("pull_request.opened sets LH_WORKTREE_PATH from git worktree list when head_ref matches", async () => {
  const repoPath = await makeRepo(
    [
      "on:",
      "  pull_request.opened:",
      '    - run: printf "%s" "$LH_WORKTREE_PATH" > wt.out',
      "",
    ].join("\n"),
  );
  const repo = S.createRepo("jugyo/wf-pr", repoPath);

  // Create a linked worktree on the PR's head branch.
  const wtPath = join(repoPath, "..", `wt-${repoPath.split("/").pop()}`);
  await worktreeAdd(repoPath, wtPath, "loophub/issue-1", "main");
  // The worktree gets its own copy of workflow.yml from the branch; the run executes in the
  // repo's local_path (primary checkout), which is what we assert below.

  const pr = S.createIssue(repo.id, "pull", "feat", "", "bot") as any;
  S.createPull(pr.id, "loophub/issue-1", "main", "abc123", null);
  const row = S.emitEvent(repo.id, "pull_request.opened", "bot", {
    number: pr.number,
  });

  await R.dispatchEvent(row);

  // git worktree list reports the canonical (realpath) form, so compare against that.
  expect(readFileSync(join(repoPath, "wt.out"), "utf8")).toBe(
    realpathSync(wtPath),
  );

  await git(repoPath, ["worktree", "remove", "--force", wtPath]);
  rmSync(repoPath, { recursive: true, force: true });
});

test("pull_request.opened sets LH_WORKTREE_PATH empty when head_ref has no worktree", async () => {
  const repoPath = await makeRepo(
    [
      "on:",
      "  pull_request.opened:",
      '    - run: printf "[%s]" "$LH_WORKTREE_PATH" > wt.out',
      "",
    ].join("\n"),
  );
  const repo = S.createRepo("jugyo/wf-pr-nowt", repoPath);
  const pr = S.createIssue(repo.id, "pull", "feat", "", "bot") as any;
  S.createPull(pr.id, "regular-branch", "main", "abc123", null);
  const row = S.emitEvent(repo.id, "pull_request.opened", "bot", {
    number: pr.number,
  });

  await R.dispatchEvent(row);

  expect(readFileSync(join(repoPath, "wt.out"), "utf8")).toBe("[]"); // empty path

  rmSync(repoPath, { recursive: true, force: true });
});

test("events without a workflow.yml or unsupported types are no-ops", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "lh-repo-"));
  await git(repoPath, ["init", "-q", "-b", "main"]); // no .loophub/workflow.yml
  const repo = S.createRepo("jugyo/wf-none", repoPath);
  const row = S.emitEvent(repo.id, "issue.opened", "me", { number: 1 });
  await expect(R.dispatchEvent(row)).resolves.toBeUndefined();
  rmSync(repoPath, { recursive: true, force: true });
});

test("log path stays under LOOPHUB_HOME/logs even for a repo name with path separators", async () => {
  const repoPath = await makeRepo(
    ["on:", "  issue.opened:", '    - run: "true"', ""].join("\n"),
  );
  // A repo name with `..` segments must not let the log file escape the logs dir.
  const repo = S.createRepo("../evil/..", repoPath);
  const issue = S.createIssue(repo.id, "issue", "x", "", "me") as any;
  const row = S.emitEvent(repo.id, "issue.opened", "me", {
    number: issue.number,
  });

  await R.dispatchEvent(row);

  const logsRoot = realpathSync(join(HOME, "logs"));
  const completed = S.listEvents(row.id, repo.id, 100).find(
    (e: any) => e.type === "workflow.run_completed",
  );
  const logFile = realpathSync(JSON.parse(completed.payload).log);
  expect(logFile.startsWith(logsRoot)).toBe(true); // never escaped logs/

  rmSync(repoPath, { recursive: true, force: true });
});
