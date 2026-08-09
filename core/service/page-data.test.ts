// The PR detail screen loads through pageData.pullDetail alone (#123): the badge counts under
// Files changed and the previous-threads list are derived from the diff the page already
// computes, so they must match what diffFeedback.list reports and must not resolve the PR's
// diff base again.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { traceGitCommands } from "../git-trace-test-helper.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-page-data-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

const REPO = "me/page-data";
const HUMAN_SESSION = "44444444-4444-4444-8444-444444444444";

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let resolvePullDiffBaseSha: typeof import("../pull-base.ts")["resolvePullDiffBaseSha"];
let repoPath: string;
let repoId: number;
let prNumber: number;

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** Base resolution is the page's git cost that folding the two calls in was meant to save. */
function baseResolutions(commands: string[]): string[] {
  return commands.filter((command) => command.startsWith("merge-base"));
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  ({ resolvePullDiffBaseSha } = await import("../pull-base.ts"));
  repoPath = mkdtempSync(join(tmpdir(), "lh-page-data-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "kept.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repoPath, "reverted.txt"), "one\ntwo\nthree\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "feature"]);
  writeFileSync(join(repoPath, "kept.txt"), "one\nkept change\nthree\n");
  writeFileSync(
    join(repoPath, "reverted.txt"),
    "one\nreverted change\nthree\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "feature"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: REPO });
  repoId = (await svc.repos.get(REPO)).id;
  const pull = await svc.pulls.create(REPO, {
    title: "page data target",
    body: "",
    head: "feature",
    base: "main",
  });
  prNumber = pull.number;
  S.registerAgentSession(HUMAN_SESSION, "me", "human-runtime");

  const baseSha = git(["merge-base", "main", "feature"]);
  const headSha = git(["rev-parse", "feature"]);
  for (const path of ["kept.txt", "reverted.txt"]) {
    await svc.diffFeedback.create(
      REPO,
      prNumber,
      {
        baseSha,
        headSha,
        path,
        side: "RIGHT",
        startLine: 2,
        endLine: 2,
        body: `About ${path}.`,
      },
      HUMAN_SESSION,
    );
  }

  // Undoing one of the two changes drops that file out of the diff, orphaning its thread while
  // the other stays anchored in the current diff.
  git(["checkout", "-q", "feature"]);
  writeFileSync(join(repoPath, "reverted.txt"), "one\ntwo\nthree\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "revert one file"]);
  git(["checkout", "-q", "main"]);
}, 30_000);

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("pullDetail carries the diff feedback the screen renders itself", async () => {
  const page = await svc.pageData.pullDetail(REPO, prNumber, "me");
  const [counts, orphaned] = await Promise.all([
    svc.diffFeedback.list(REPO, prNumber),
    svc.diffFeedback.list(REPO, prNumber, { orphaned: true }),
  ]);

  expect(page.files.map((file) => file.filename)).toEqual(["kept.txt"]);
  expect(page.diff_feedback.comment_counts).toEqual(counts.comment_counts);
  expect(page.diff_feedback.comment_counts).toEqual({ "kept.txt": 1 });
  expect(page.diff_feedback.orphaned_threads).toEqual(orphaned.threads);
  expect(
    page.diff_feedback.orphaned_threads.map((thread) => thread.anchor.path),
  ).toEqual(["reverted.txt"]);
});

test("pullDetail resolves the PR's diff base once", async () => {
  const pull = S.getPull(S.getIssue(repoId, prNumber)!.id)!;
  const once = await traceGitCommands(() =>
    resolvePullDiffBaseSha(repoPath, pull),
  );
  const page = await traceGitCommands(() =>
    svc.pageData.pullDetail(REPO, prNumber, "me"),
  );

  // The commit list on the PR row, Files changed, and the diff feedback anchors all share the
  // one resolution the page makes — the whole request costs what resolving it alone costs.
  expect(baseResolutions(once.commands).length).toBeGreaterThan(0);
  expect(baseResolutions(page.commands).length).toBe(
    baseResolutions(once.commands).length,
  );
  // Not a vacuous equality: asking for the same feedback through its own RPC resolves the base
  // again, which is what the screen used to pay twice more on load.
  const separate = await traceGitCommands(() =>
    svc.diffFeedback.list(REPO, prNumber, { orphaned: true }),
  );
  expect(baseResolutions(separate.commands).length).toBeGreaterThan(0);
});

test("pullDetail reads the diff feedback as the calling session", async () => {
  const thread = (
    await svc.diffFeedback.list(REPO, prNumber, { orphaned: true })
  ).threads[0];
  await svc.diffFeedback.react(
    REPO,
    prNumber,
    thread.messages[0].id,
    "👍",
    HUMAN_SESSION,
  );

  const asHuman = await svc.pageData.pullDetail(
    REPO,
    prNumber,
    "me",
    HUMAN_SESSION,
  );
  const asStranger = await svc.pageData.pullDetail(REPO, prNumber, "me");

  // Same actor rule as diffFeedback/list: without it a reader's own reaction comes back
  // unreacted and the UI's optimistic toggle runs opposite to the server.
  expect(
    asHuman.diff_feedback.orphaned_threads[0].messages[0].reactions,
  ).toEqual([{ emoji: "👍", count: 1, reacted: true }]);
  expect(
    asStranger.diff_feedback.orphaned_threads[0].messages[0].reactions,
  ).toEqual([{ emoji: "👍", count: 1, reacted: false }]);
});
