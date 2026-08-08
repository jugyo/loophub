import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { clearGitResultCache } from "../git-cache.ts";
import { traceGitCommands } from "../git-trace-test-helper.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-pull-commits-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let repoPath: string;
let commitFilesRepoPath: string;
let commitFilesPullNumber: number;
let featureSha: string;
let outsideSha: string;

function gitAt(
  path: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  const result = spawnSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function git(args: string[], env: Record<string, string> = {}): string {
  return gitAt(repoPath, args, env);
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-pull-commits-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  git(["commit", "--allow-empty", "-qm", "base"]);
  const latestTimestamp = Date.parse("2026-06-18T12:00:00Z") / 1000;
  const stream: string[] = [];
  for (let i = 1; i <= 102; i += 1) {
    const subject = `commit ${String(i).padStart(3, "0")}`;
    const author = i === 102 ? "Latest Author" : "tester";
    const timestamp = latestTimestamp - (102 - i);
    stream.push(
      "commit refs/heads/feature",
      `author ${author} <t@t.local> ${timestamp} +0000`,
      `committer ${author} <t@t.local> ${timestamp} +0000`,
      `data ${Buffer.byteLength(subject)}`,
      subject,
      ...(i === 1 ? ["from refs/heads/main"] : []),
      "",
    );
  }
  const imported = spawnSync(
    "git",
    ["-C", repoPath, "fast-import", "--quiet"],
    { encoding: "utf8", input: stream.join("\n") },
  );
  if (imported.status !== 0) throw new Error(imported.stderr);
  await svc.repos.create({ path: repoPath, name: "me/proj" });

  commitFilesRepoPath = mkdtempSync(
    join(tmpdir(), "lh-pull-commit-files-repo-"),
  );
  const commitGit = (args: string[]) => gitAt(commitFilesRepoPath, args);
  commitGit(["init", "-q", "-b", "main"]);
  commitGit(["config", "user.email", "t@t.local"]);
  commitGit(["config", "user.name", "tester"]);
  writeFileSync(join(commitFilesRepoPath, "a.txt"), "before\n");
  commitGit(["add", "-A"]);
  commitGit(["commit", "-qm", "base"]);
  commitGit(["checkout", "-qb", "feature"]);
  writeFileSync(join(commitFilesRepoPath, "a.txt"), "after\n");
  writeFileSync(join(commitFilesRepoPath, "added.txt"), "new\n");
  commitGit(["add", "-A"]);
  commitGit(["commit", "-qm", "feature change"]);
  featureSha = commitGit(["rev-parse", "HEAD"]);
  commitGit(["checkout", "-q", "main"]);
  writeFileSync(join(commitFilesRepoPath, "outside.txt"), "outside\n");
  commitGit(["add", "-A"]);
  commitGit(["commit", "-qm", "outside PR"]);
  outsideSha = commitGit(["rev-parse", "HEAD"]);

  await svc.repos.create({
    path: commitFilesRepoPath,
    name: "me/commit-files",
  });
  const pull = await svc.pulls.create("me/commit-files", {
    title: "commit files",
    head: "feature",
    base: "main",
  });
  commitFilesPullNumber = pull.number;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(commitFilesRepoPath, { recursive: true, force: true });
});

test("pull detail returns the newest 100 base..head commits with wire metadata", async () => {
  const pull = await svc.pulls.create("me/proj", {
    title: "commit history",
    head: "feature",
    base: "main",
  });

  const detail = await svc.pulls.get("me/proj", pull.number);

  expect(detail.commits).toHaveLength(100);
  expect(detail.commits?.[0]).toEqual({
    sha: git(["rev-parse", "feature"]),
    author: "Latest Author",
    date: expect.any(String),
    subject: "commit 102",
  });
  expect(new Date(detail.commits?.[0]?.date ?? "").toISOString()).toBe(
    "2026-06-18T12:00:00.000Z",
  );
  expect(detail.commits?.at(-1)?.subject).toBe("commit 003");
  expect(
    detail.commits?.every((commit) => /^[0-9a-f]{40}$/.test(commit.sha)),
  ).toBe(true);
  expect(
    detail.commits?.every((commit) => !("pushed_to_github" in commit)),
  ).toBe(true);
});

test("pull detail returns an empty commit list before the head branch exists", async () => {
  const pull = await svc.pulls.create("me/proj", {
    title: "not provisioned yet",
    head: "future-head",
    base: "main",
  });

  const detail = await svc.pulls.get("me/proj", pull.number);

  expect(detail.commits).toEqual([]);
});

test("archive hides the PR from lists while preserving its data and git branch", async () => {
  const pull = await svc.pulls.create("me/proj", {
    title: "archive me",
    head: "feature",
    base: "main",
  });
  const headBefore = git(["rev-parse", "feature"]);

  expect(await svc.pulls.archive("me/proj", pull.number)).toEqual({ ok: true });
  expect(
    (await svc.pulls.get("me/proj", pull.number)).archived_at,
  ).toBeTruthy();
  expect(
    (await svc.pulls.list("me/proj")).some((p) => p.number === pull.number),
  ).toBe(false);
  expect(git(["rev-parse", "feature"])).toBe(headBefore);

  expect(svc.pulls.unarchive("me/proj", pull.number)).toEqual({ ok: true });
  expect((await svc.pulls.get("me/proj", pull.number)).archived_at).toBeNull();
  expect(
    (await svc.pulls.list("me/proj")).some((p) => p.number === pull.number),
  ).toBe(true);
});

test("archive preserves an imported GitHub issue link", async () => {
  const pull = await svc.pulls.create("me/proj", {
    title: "archive imported link",
    head: "feature",
    base: "main",
  });
  const issue = S.getIssue((await svc.repos.get("me/proj")).id, pull.number)!;
  S.recordGithubIssue({
    issueId: issue.id,
    owner: "octocat",
    repo: "hello-world",
    number: 1,
    url: "https://github.com/octocat/hello-world/issues/1",
  });

  expect(svc.pulls.archive("me/proj", pull.number)).toEqual({ ok: true });
  expect(S.getGithubIssue(issue.id)?.url).toBe(
    "https://github.com/octocat/hello-world/issues/1",
  );
});

test("unarchive refuses a second open pull linked to the same issue", async () => {
  const issue = svc.issues.create("me/proj", { title: "one active pull" });
  const archived = await svc.pulls.create("me/proj", {
    title: "archived attempt",
    head: "archived-attempt",
    base: "main",
    issue: issue.number,
  });
  svc.pulls.archive("me/proj", archived.number);
  const active = await svc.pulls.create("me/proj", {
    title: "active attempt",
    head: "active-attempt",
    base: "main",
    issue: issue.number,
  });

  expect(() => svc.pulls.unarchive("me/proj", archived.number)).toThrow(
    `issue #${issue.number} already has an open pull request`,
  );
  expect(
    (await svc.pulls.get("me/proj", archived.number)).archived_at,
  ).toBeTruthy();
  const listed = (await svc.pulls.list("me/proj")).map((pull) => pull.number);
  expect(listed).toContain(active.number);
  expect(listed).not.toContain(archived.number);
});

test("pull detail surfaces a git log failure", async () => {
  const pull = await svc.pulls.create("me/proj", {
    title: "broken log",
    head: "feature",
    base: "main",
  });
  const bin = mkdtempSync(join(HOME, "bin-"));
  const fakeGit = join(bin, "git");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(
    fakeGit,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "log" ]; then
    echo "simulated git log failure" >&2
    exit 1
  fi
done
exec "${realGit}" "$@"
`,
  );
  chmodSync(fakeGit, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;

  try {
    await expect(svc.pulls.get("me/proj", pull.number)).rejects.toThrow(
      /simulated git log failure/,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("repos/commitFiles returns a commit's parent diff", async () => {
  const files = await svc.repos.commitFiles("me/commit-files", featureSha);

  expect(files).toEqual([
    {
      filename: "a.txt",
      headFilename: "a.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: expect.stringContaining("+after"),
    },
    {
      filename: "added.txt",
      headFilename: "added.txt",
      status: "added",
      additions: 1,
      deletions: 0,
      patch: expect.stringContaining("+new"),
    },
  ]);
});

test("diff roots absolute paths at the PR worktree with a repo fallback", async () => {
  const withoutWorktree = await svc.pulls.diff(
    "me/commit-files",
    commitFilesPullNumber,
    "a.txt",
  );

  expect(withoutWorktree.files).toHaveLength(1);
  expect(withoutWorktree.files[0]).toMatchObject({
    path: "a.txt",
    absolute_path: join(commitFilesRepoPath, "a.txt"),
  });

  const worktreePath = join(
    HOME,
    "worktrees",
    "me",
    "commit-files",
    `pr-${commitFilesPullNumber}`,
  );
  mkdirSync(dirname(worktreePath), { recursive: true });
  gitAt(commitFilesRepoPath, ["worktree", "add", worktreePath, "feature"]);

  const withWorktree = await svc.pulls.diff(
    "me/commit-files",
    commitFilesPullNumber,
    "a.txt",
  );
  expect(withWorktree.files[0]).toMatchObject({
    path: "a.txt",
    absolute_path: join(worktreePath, "a.txt"),
  });
});

// #2417: After merging an advanced base into head, Changed Files must still list only the
// PR's own changes. Comparing the stored fork-point to head as a two-dot tree diff would
// surface base-side files that arrived via the merge commit.
test("diff excludes base-side files after merging an advanced base into head", async () => {
  const path = mkdtempSync(join(tmpdir(), "lh-pull-diff-merge-base-"));
  const g = (args: string[]) => gitAt(path, args);
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(path, "shared.txt"), "shared\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  const forkSha = g(["rev-parse", "main"]);
  g(["checkout", "-qb", "feature"]);
  writeFileSync(join(path, "feature-only.txt"), "from pr\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "pr change"]);
  g(["checkout", "-q", "main"]);

  await svc.repos.create({ path, name: "me/diff-merge-base" });
  const pull = await svc.pulls.create("me/diff-merge-base", {
    title: "merge base into head",
    head: "feature",
    base: "main",
  });
  // Fork point is recorded at create; still matches the live merge-base for now.
  expect(pull.base_sha).toBe(forkSha);

  const before = await svc.pulls.diff("me/diff-merge-base", pull.number);
  expect(before.files.map((f) => f.path).sort()).toEqual(["feature-only.txt"]);

  // Base advances with an unrelated file, then is merged into the PR head.
  writeFileSync(join(path, "base-only.txt"), "from base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "advance main"]);
  const advancedMain = g(["rev-parse", "main"]);
  g(["checkout", "-q", "feature"]);
  g(["merge", "-q", "main", "-m", "merge main into feature"]);
  const headSha = g(["rev-parse", "HEAD"]);

  const after = await svc.pulls.diff("me/diff-merge-base", pull.number);
  expect(after.base_sha).toBe(advancedMain);
  expect(after.head_sha).toBe(headSha);
  expect(after.files.map((f) => f.path).sort()).toEqual(["feature-only.txt"]);
  expect(after.files.some((f) => f.path === "base-only.txt")).toBe(false);
  // Stored fork point is unchanged and must not be used as the live diff base.
  const row = S.getPull(
    S.getIssue(S.getRepo("me", "diff-merge-base")!.id, pull.number)!.id,
  )!;
  expect(row.base_sha).toBe(forkSha);
  expect(after.base_sha).not.toBe(forkSha);

  // A PR without any base merge still lists only its own files (no regression).
  const plainPath = mkdtempSync(join(tmpdir(), "lh-pull-diff-plain-"));
  const pg = (args: string[]) => gitAt(plainPath, args);
  pg(["init", "-q", "-b", "main"]);
  pg(["config", "user.email", "t@t.local"]);
  pg(["config", "user.name", "tester"]);
  writeFileSync(join(plainPath, "a.txt"), "a\n");
  pg(["add", "-A"]);
  pg(["commit", "-qm", "base"]);
  const plainFork = pg(["rev-parse", "main"]);
  pg(["checkout", "-qb", "feature"]);
  writeFileSync(join(plainPath, "b.txt"), "b\n");
  pg(["add", "-A"]);
  pg(["commit", "-qm", "feature"]);
  const plainHead = pg(["rev-parse", "HEAD"]);
  pg(["checkout", "-q", "main"]);

  await svc.repos.create({ path: plainPath, name: "me/diff-plain" });
  const plainPull = await svc.pulls.create("me/diff-plain", {
    title: "plain pr",
    head: "feature",
    base: "main",
  });
  const plainDiff = await svc.pulls.diff("me/diff-plain", plainPull.number);
  expect(plainDiff).toMatchObject({
    base_sha: plainFork,
    head_sha: plainHead,
  });
  expect(plainDiff.files.map((f) => f.path)).toEqual(["b.txt"]);

  rmSync(path, { recursive: true, force: true });
  rmSync(plainPath, { recursive: true, force: true });
});

// #2420: UI Files changed uses pulls.files. When local main lags and the PR merges
// origin/main, both files() and diff() must drop the remote-only base files.
test("files and diff exclude origin/main-only files when local base lags", async () => {
  const path = mkdtempSync(join(tmpdir(), "lh-pull-files-origin-base-"));
  const g = (args: string[]) => gitAt(path, args);
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(path, "shared.txt"), "shared\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  const localFork = g(["rev-parse", "main"]);
  g(["checkout", "-qb", "feature"]);
  writeFileSync(join(path, "feature-only.txt"), "from pr\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "pr change"]);
  g(["checkout", "-q", "main"]);

  writeFileSync(join(path, "base-only.txt"), "from origin main\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "advance origin/main"]);
  const originMain = g(["rev-parse", "main"]);
  g(["update-ref", "refs/remotes/origin/main", originMain]);
  // Hard-reset local main so the working tree matches the stale tip.
  g(["reset", "--hard", localFork]);

  g(["checkout", "-q", "feature"]);
  g([
    "merge",
    "-q",
    "refs/remotes/origin/main",
    "-m",
    "merge origin/main into feature",
  ]);
  const headSha = g(["rev-parse", "HEAD"]);

  await svc.repos.create({ path, name: "me/files-origin-base" });
  const pull = await svc.pulls.create("me/files-origin-base", {
    title: "stale local base",
    head: "feature",
    base: "main",
  });

  const files = await svc.pulls.files("me/files-origin-base", pull.number);
  expect(files.map((f) => f.headFilename ?? f.filename).sort()).toEqual([
    "feature-only.txt",
  ]);
  expect(
    files.some((f) => (f.headFilename ?? f.filename) === "base-only.txt"),
  ).toBe(false);

  const diff = await svc.pulls.diff("me/files-origin-base", pull.number);
  expect(diff.base_sha).toBe(originMain);
  expect(diff.head_sha).toBe(headSha);
  expect(diff.files.map((f) => f.path).sort()).toEqual(["feature-only.txt"]);
  expect(diff.files.some((f) => f.path === "base-only.txt")).toBe(false);

  rmSync(path, { recursive: true, force: true });
});

// #2444: rebasing the base branch rewrites the commits head forked from, so they stop being
// reachable from the base tip. Files changed and Commits must keep showing only the PR's own work.
test("files and commits exclude base-side work after the base branch is rebased", async () => {
  const path = mkdtempSync(join(tmpdir(), "lh-pull-rebased-base-"));
  const g = (args: string[]) => gitAt(path, args);
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(path, "shared.txt"), "shared\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "root"]);
  const root = g(["rev-parse", "main"]);
  writeFileSync(join(path, "base-only.txt"), "from base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base work"]);
  g(["checkout", "-qb", "feature"]);
  writeFileSync(join(path, "feature-only.txt"), "from pr\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "pr change"]);
  g(["checkout", "-q", "main"]);

  await svc.repos.create({ path, name: "me/rebased-base" });
  const pull = await svc.pulls.create("me/rebased-base", {
    title: "rebased base",
    head: "feature",
    base: "main",
  });

  // Rewrite "base work" so main no longer contains the commit feature forked from.
  g(["reset", "--hard", "-q", root]);
  writeFileSync(join(path, "base-only.txt"), "from base\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base work, rewritten"]);
  expect(g(["merge-base", "main", "feature"])).toBe(root);

  const files = await svc.pulls.files("me/rebased-base", pull.number);
  expect(files.map((f) => f.headFilename ?? f.filename)).toEqual([
    "feature-only.txt",
  ]);

  const detail = await svc.pulls.get("me/rebased-base", pull.number);
  expect(detail.commits?.map((commit) => commit.subject)).toEqual([
    "pr change",
  ]);

  rmSync(path, { recursive: true, force: true });
});

test("repos/commitFiles returns commits outside a pull request", async () => {
  const files = await svc.repos.commitFiles("me/commit-files", outsideSha);
  expect(files).toHaveLength(1);
  expect(files[0].filename).toBe("outside.txt");
});

test("repos/commitFiles rejects an arbitrary ref instead of resolving it", async () => {
  await expect(
    svc.repos.commitFiles("me/commit-files", "main"),
  ).rejects.toMatchObject({ status: 404, message: "Not Found" });
});

test("repos/commitFiles surfaces a git diff failure", async () => {
  const bin = mkdtempSync(join(HOME, "commit-diff-bin-"));
  const fakeGit = join(bin, "git");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(
    fakeGit,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "diff" ]; then
    echo "simulated git diff failure" >&2
    exit 1
  fi
done
exec "${realGit}" "$@"
`,
  );
  chmodSync(fakeGit, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  // This commit's parent diff is immutable, so an earlier test left it cached and the stub would
  // never be reached. A fresh process would run git here, which is the path under test.
  clearGitResultCache();

  try {
    await expect(
      svc.repos.commitFiles("me/commit-files", featureSha),
    ).rejects.toThrow(/simulated git diff failure/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("repos/commitFiles returns the diff for an initial commit", async () => {
  const initialSha = gitAt(commitFilesRepoPath, [
    "rev-list",
    "--max-parents=0",
    "main",
  ]);
  const files = await svc.repos.commitFiles("me/commit-files", initialSha);
  expect(files).toEqual([
    expect.objectContaining({
      filename: "a.txt",
      status: "added",
      patch: expect.stringContaining("+before"),
    }),
  ]);
});

// #2263: the usage totals used to be readable only through the PR / issue detail payloads, whose
// serializers run a git status fan-out. A running agent updates them every few seconds, so the
// slice is served on its own — and the point of the split is that this path never spawns git.
test("usage returns the PR's agent-cost totals without touching git", async () => {
  const pull = await svc.pulls.create("me/proj", {
    title: "usage totals",
    head: "feature",
    base: "main",
  });
  const issue = S.getIssue(S.getRepo("me", "proj")!.id, pull.number)!;

  // No linked session with usage yet: the fields are omitted rather than reported as zero.
  expect(await svc.pulls.usage("me/proj", pull.number)).toEqual({
    number: pull.number,
  });

  const session = "77777777-0000-4000-8000-000000000001";
  S.registerAgentSession(session, "lh-build", "ext-usage");
  S.linkSession(session, issue.id);
  S.upsertSessionUsage(session, {
    model: "claude-sonnet-5",
    input_tokens: 10,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
    output_tokens: 3,
    cost_usd: 0.5,
  });

  const traced = await traceGitCommands(async () =>
    svc.pulls.usage("me/proj", pull.number),
  );
  expect(traced.result).toEqual({
    number: pull.number,
    total_tokens: 16,
    cost_usd: 0.5,
  });
  expect(traced.commands).toEqual([]);
});
