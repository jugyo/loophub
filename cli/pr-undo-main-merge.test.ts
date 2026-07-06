import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/prundo";

let home: string;
let repoPath: string;

function lh(args: string[]) {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPHUB_HOME: home,
        LOOPHUB_DB: join(home, "loophub.db"),
      },
    },
  );
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function createIssue(): number {
  const { stdout, stderr, exitCode } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "undo target",
    "--body",
    "body",
  ]);
  if (exitCode !== 0) throw new Error(`issue create failed: ${stderr}`);
  const m = stdout.match(/created #(\d+)/);
  if (!m) throw new Error(`missing issue number: ${stdout}`);
  return Number(m[1]);
}

function viewPr(number: number) {
  const { stdout, stderr, exitCode } = lh([
    "pr",
    "view",
    String(number),
    "--repo",
    REPO,
    "--json",
  ]);
  if (exitCode !== 0) throw new Error(`pr view failed: ${stderr}`);
  return JSON.parse(stdout);
}

function viewIssue(number: number) {
  const { stdout, stderr, exitCode } = lh([
    "issue",
    "view",
    String(number),
    "--repo",
    REPO,
    "--json",
  ]);
  if (exitCode !== 0) throw new Error(`issue view failed: ${stderr}`);
  return JSON.parse(stdout);
}

function createMergedPr(branch: string): {
  issue: number;
  pr: number;
  before: string;
} {
  const issue = createIssue();
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), `${branch}\n`);
  git(["add", "-A"]);
  git(["commit", "-qm", branch]);
  git(["checkout", "-q", "main"]);
  const before = git(["rev-parse", "main"]);

  const created = lh([
    "pr",
    "create",
    "--repo",
    REPO,
    "--head",
    branch,
    "--base",
    "main",
    "--title",
    `undo ${branch}`,
    "--issue",
    String(issue),
  ]);
  expect(created.exitCode).toBe(0);
  const m = created.stdout.match(/created PR #(\d+)/);
  if (!m) throw new Error(`missing PR number: ${created.stdout}`);
  const pr = Number(m[1]);

  const merged = lh([
    "pr",
    "merge",
    String(pr),
    "--repo",
    REPO,
    "--method",
    "merge",
  ]);
  expect(merged.exitCode).toBe(0);
  expect(git(["rev-parse", "main"])).not.toBe(before);
  return { issue, pr, before };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loophub-prundo-home-"));
  process.env.LOOPHUB_HOME = home;
  process.env.LOOPHUB_DB = join(home, "loophub.db");
  repoPath = mkdtempSync(join(tmpdir(), "loophub-prundo-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "base.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  const add = lh(["repo", "add", repoPath, "--name", REPO]);
  if (add.exitCode !== 0) throw new Error(`repo add failed: ${add.stderr}`);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("lh pr undo-main-merge matches the JSON-RPC undo state transition", async () => {
  const cli = createMergedPr("feature-cli");

  const undone = lh(["pr", "undo-main-merge", String(cli.pr), "--repo", REPO]);

  expect(undone.exitCode).toBe(0);
  expect(undone.stdout).toMatch(/undone: main reset to .*audit #\d+/);
  expect(git(["rev-parse", "main"])).toBe(cli.before);
  const afterCliPr = viewPr(cli.pr);
  expect(afterCliPr.state).toBe("open");
  expect(afterCliPr.merged).toBe(false);
  expect(afterCliPr.merge_commit_sha).toBeNull();
  expect(viewIssue(cli.issue).state).toBe("open");

  const rpc = createMergedPr("feature-rpc");
  const [{ dispatch }, S] = await Promise.all([
    import("../web/server/rpc.ts"),
    import("../core/store.ts"),
  ]);
  const response = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "pulls/undoMainMerge",
    params: { repo: REPO, number: rpc.pr, session_id: "rpc-test" },
  });

  if (!response || Array.isArray(response) || !("result" in response)) {
    throw new Error(`unexpected RPC response: ${JSON.stringify(response)}`);
  }
  expect(response.result).toMatchObject({ undone: true, sha: rpc.before });
  expect(git(["rev-parse", "main"])).toBe(rpc.before);
  const afterRpcPr = viewPr(rpc.pr);
  expect(afterRpcPr.state).toBe(afterCliPr.state);
  expect(afterRpcPr.merged).toBe(afterCliPr.merged);
  expect(afterRpcPr.merge_commit_sha).toBe(afterCliPr.merge_commit_sha);
  expect(viewIssue(rpc.issue).state).toBe(viewIssue(cli.issue).state);

  const repo = S.getRepo("me", "prundo")!;
  const cliRow = S.getIssue(repo.id, cli.pr);
  const rpcRow = S.getIssue(repo.id, rpc.pr);
  expect(S.listMainMergeUndos(cliRow.id)).toHaveLength(1);
  expect(S.listMainMergeUndos(rpcRow.id)).toHaveLength(1);
});
