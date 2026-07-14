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

function git(args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
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
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
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
