import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-pull-commits-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");
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

test("commitFiles returns the selected PR commit's parent diff", async () => {
  const files = await svc.pulls.commitFiles(
    "me/commit-files",
    commitFilesPullNumber,
    featureSha,
  );

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

test("commitFiles rejects a SHA outside the pull request's base..head range", async () => {
  await expect(
    svc.pulls.commitFiles("me/commit-files", commitFilesPullNumber, outsideSha),
  ).rejects.toMatchObject({ status: 404, message: "Not Found" });
});

test("commitFiles rejects an arbitrary ref instead of resolving it", async () => {
  await expect(
    svc.pulls.commitFiles("me/commit-files", commitFilesPullNumber, "main"),
  ).rejects.toMatchObject({ status: 404, message: "Not Found" });
});

test("commitFiles surfaces a git diff failure", async () => {
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

  try {
    await expect(
      svc.pulls.commitFiles(
        "me/commit-files",
        commitFilesPullNumber,
        featureSha,
      ),
    ).rejects.toThrow(/simulated git diff failure/);
  } finally {
    process.env.PATH = originalPath;
  }
});
