import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/pr-feedback";
const home = mkdtempSync(join(tmpdir(), "lh-feedback-home-"));
const repoPath = mkdtempSync(join(tmpdir(), "lh-feedback-repo-"));

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      LOOPHUB_HOME: home,
      LOOPHUB_DB: join(home, "loophub.db"),
    },
  });
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
}

function git(args: string[]) {
  return run("git", ["-C", repoPath, ...args]);
}

function lh(args: string[]) {
  return run(process.execPath, [
    "--experimental-sqlite",
    "--disable-warning=ExperimentalWarning",
    "--import",
    "tsx",
    CLI,
    ...args,
  ]);
}

let prNumber: number;
let baseSha: string;
let headSha: string;

beforeAll(() => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(
    join(repoPath, "rename-old.txt"),
    "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  baseSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "-qb", "feature"]);
  writeFileSync(join(repoPath, "a.txt"), "one\nchanged\nthree\nadded\n");
  git(["mv", "rename-old.txt", "rename-new.txt"]);
  writeFileSync(
    join(repoPath, "rename-new.txt"),
    "one\nchanged\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "feature"]);
  headSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);
  lh(["repo", "add", repoPath, "--name", REPO]);
  const pull = JSON.parse(
    lh([
      "pr",
      "create",
      "--repo",
      REPO,
      "--head",
      "feature",
      "--base",
      "main",
      "--title",
      "feedback target",
      "--json",
    ]),
  );
  prNumber = pull.number;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("CLI creates, reads, replies to, resolves, and reopens a diff thread", () => {
  const diff = JSON.parse(
    lh(["pr", "diff", String(prNumber), "--repo", REPO, "--json"]),
  );
  expect(diff).toMatchObject({ base_sha: baseSha, head_sha: headSha });
  const changed = diff.files.find(
    (file: { path: string }) => file.path === "a.txt",
  );
  expect(changed).toMatchObject({ path: "a.txt", original_path: null });
  expect(changed.lines).toContainEqual(
    expect.objectContaining({ right_line: 2, kind: "addition" }),
  );

  const created = JSON.parse(
    lh([
      "pr",
      "feedback",
      "create",
      String(prNumber),
      "--repo",
      REPO,
      "--base-sha",
      baseSha,
      "--head-sha",
      headSha,
      "--path",
      "a.txt",
      "--side",
      "RIGHT",
      "--start-line",
      "2",
      "--end-line",
      "2",
      "--kind",
      "question",
      "--body",
      "Why?",
      "--json",
    ]),
  );
  expect(created.thread).toMatchObject({
    freshness: "current",
    status: "open",
    anchor: { path: "a.txt", side: "RIGHT", start_line: 2, end_line: 2 },
  });
  expect(created.request).toMatchObject({ kind: "question", body: "Why?" });

  const listed = JSON.parse(
    lh(["pr", "feedback", "list", String(prNumber), "--repo", REPO, "--json"]),
  );
  expect(listed.threads).toHaveLength(1);

  const reply = JSON.parse(
    lh([
      "pr",
      "feedback",
      "reply",
      String(created.thread.id),
      "--pr",
      String(prNumber),
      "--request-message",
      String(created.request.id),
      "--body",
      "Because.",
      "--repo",
      REPO,
      "--json",
    ]),
  );
  expect(reply.reply).toMatchObject({
    kind: "reply",
    body: "Because.",
    reply_to_id: created.request.id,
  });

  for (const action of ["resolve", "reopen"]) {
    const thread = JSON.parse(
      lh([
        "pr",
        "feedback",
        action,
        String(created.thread.id),
        "--pr",
        String(prNumber),
        "--repo",
        REPO,
        "--json",
      ]),
    );
    expect(thread.status).toBe(action === "resolve" ? "resolved" : "open");
  }
});

test("rename LEFT anchors use the diff wire head path contract", () => {
  const diff = JSON.parse(
    lh(["pr", "diff", String(prNumber), "--repo", REPO, "--json"]),
  );
  const renamed = diff.files.find(
    (file: { path: string }) => file.path === "rename-new.txt",
  );
  expect(renamed).toMatchObject({
    path: "rename-new.txt",
    original_path: "rename-old.txt",
    status: "renamed",
  });

  const created = JSON.parse(
    lh([
      "pr",
      "feedback",
      "create",
      String(prNumber),
      "--repo",
      REPO,
      "--base-sha",
      baseSha,
      "--head-sha",
      headSha,
      "--path",
      renamed.path,
      "--side",
      "LEFT",
      "--start-line",
      "2",
      "--end-line",
      "2",
      "--kind",
      "feedback",
      "--body",
      "Keep the old name.",
      "--json",
    ]),
  );
  expect(created.thread.anchor).toMatchObject({
    path: "rename-new.txt",
    original_path: "rename-old.txt",
    side: "LEFT",
    start_line: 2,
    end_line: 2,
  });
});

test("a saved anchor becomes outdated when the PR head advances", () => {
  git(["checkout", "-q", "feature"]);
  writeFileSync(join(repoPath, "later.txt"), "later\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "later"]);
  git(["checkout", "-q", "main"]);
  const listed = JSON.parse(
    lh(["pr", "feedback", "list", String(prNumber), "--repo", REPO, "--json"]),
  );
  expect(listed.threads[0].freshness).toBe("outdated");
});

test("create rejects a stale commit pair", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      "pr",
      "feedback",
      "create",
      String(prNumber),
      "--repo",
      REPO,
      "--base-sha",
      baseSha,
      "--head-sha",
      headSha,
      "--path",
      "a.txt",
      "--side",
      "RIGHT",
      "--start-line",
      "2",
      "--end-line",
      "2",
      "--body",
      "stale",
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
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("error 409: pull request diff has changed");
});

test("reading feedback surfaces git failures instead of reporting unavailable", () => {
  const bin = mkdtempSync(join(home, "bin-"));
  const fakeGit = join(bin, "git");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(
    fakeGit,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "diff" ]; then
    echo "simulated feedback diff failure" >&2
    exit 1
  fi
done
exec "${realGit}" "$@"
`,
  );
  chmodSync(fakeGit, 0o755);

  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      "pr",
      "feedback",
      "list",
      String(prNumber),
      "--repo",
      REPO,
      "--json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPHUB_HOME: home,
        LOOPHUB_DB: join(home, "loophub.db"),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("simulated feedback diff failure");
  expect(result.stdout).not.toContain('"freshness": "unavailable"');
});
