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
import type { PullTimelineItemWire } from "../serialize.ts";
import { configureSlowOperationLogging } from "../slow-operation.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-page-data-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

const REPO = "me/page-data";
const HUMAN_SESSION = "44444444-4444-4444-8444-444444444444";

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let resolvePullDiffBaseSha: typeof import("../pull-base.ts")["resolvePullDiffBaseSha"];
let resolvePullDiffOperands: typeof import("./pulls.ts")["resolvePullDiffOperands"];
let diffFilesBetween: typeof import("../git.ts")["diffFilesBetween"];
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
  ({ resolvePullDiffOperands } = await import("./pulls.ts"));
  ({ diffFilesBetween } = await import("../git.ts"));
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

  // #145/#215: a review (with a line comment) and a conversation comment. The line comment remains
  // available for the Diff view but is not a timeline entry. Created before the revert below, so
  // they predate the newest commit.
  await svc.comments.createHumanForPull(
    REPO,
    prNumber,
    "First conversation comment",
  );
  await svc.reviews.create(REPO, prNumber, {
    event: "PASS",
    body: "LGTM",
    model: "test-model",
    comments: [
      { path: "kept.txt", line: 2, side: "RIGHT", body: "Nice change." },
    ],
  });

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
  const featureCommit = page.pull.commits?.find(
    (commit) => commit.subject === "feature",
  );
  expect(page.files[0].last_changed_at).toBe(featureCommit?.date);
  expect(page.files[0].last_changed_sha).toBe(featureCommit?.sha);
  expect(page.diff_feedback.comment_counts).toEqual(counts.comment_counts);
  expect(page.diff_feedback.comment_counts).toEqual({ "kept.txt": 1 });
  expect(page.diff_feedback.orphaned_threads).toEqual(orphaned.threads);
  expect(
    page.diff_feedback.orphaned_threads.map((thread) => thread.anchor.path),
  ).toEqual(["reverted.txt"]);
});

test("pageData logs issueList and pullDetail subphases in debug mode", async () => {
  const logs: string[] = [];
  configureSlowOperationLogging((message) => logs.push(message));
  try {
    await svc.pageData.issueList(REPO);
    await svc.pageData.pullDetail(REPO, prNumber, "me");
  } finally {
    configureSlowOperationLogging();
  }

  expect(logs).toContainEqual(
    expect.stringMatching(
      /^pageData phase=issueList\.issue_selection duration_ms=\d+$/,
    ),
  );
  expect(logs).toContainEqual(
    expect.stringMatching(
      /^pageData phase=issueList\.workflow_state_projection duration_ms=\d+$/,
    ),
  );
  expect(logs).toContainEqual(
    expect.stringMatching(
      /^pageData phase=pullDetail.diff_base_resolution duration_ms=\d+$/,
    ),
  );
  expect(logs).toContainEqual(
    expect.stringMatching(
      /^pageData phase=pullDetail.feedback_assembly duration_ms=\d+$/,
    ),
  );
});

test("pullDetail assembles the PR timeline from data it already fetched", async () => {
  const page = await svc.pageData.pullDetail(REPO, prNumber, "me");
  const ofKind = <TKind extends PullTimelineItemWire["kind"]>(kind: TKind) =>
    page.timeline.filter(
      (item): item is Extract<PullTimelineItemWire, { kind: TKind }> =>
        item.kind === kind,
    );

  // Timeline sources show up exactly once; line comments are fetched separately for the Diff view.
  expect(page.timeline.length).toBe(
    (page.pull.commits ?? []).length +
      page.reviews.length +
      page.comments.length,
  );
  expect(ofKind("commit")).toHaveLength((page.pull.commits ?? []).length);
  expect(ofKind("review")).toHaveLength(page.reviews.length);
  expect(ofKind("comment")).toHaveLength(page.comments.length);
  expect(page.line_comments).toHaveLength(1);
  expect(page.line_comments[0].body).toBe("Nice change.");
  expect(page.timeline.some((item) => "line_comment" in item)).toBe(false);

  // Chronological, oldest first — the backend's one job, since the frontend renders as-is.
  const times = page.timeline.map((item) => Date.parse(item.created_at));
  expect([...times].sort((a, b) => a - b)).toEqual(times);

  // Entries reuse the git-derived commit rows and the comment rows rather than re-fetching them.
  // pull.commits is newest-first; the timeline is oldest-first, so the commit list reads reversed.
  expect(ofKind("commit").map((item) => item.commit.sha)).toEqual(
    [...(page.pull.commits ?? [])].reverse().map((commit) => commit.sha),
  );
  expect(ofKind("comment").map((item) => item.comment.body)).toEqual(
    page.comments.map((comment) => comment.body),
  );
});

// #2500: the GitHub side of the PR reads in the same list as the LoopHub side. Everything here is
// already-observed data — no `gh` runs — so the entries appear for whatever the worker's sweeps saw.
test("pullDetail folds the observed GitHub activity into the timeline", async () => {
  const issueId = S.getIssue(repoId, prNumber)!.id;
  const url = "https://github.com/upstream/proj/pull/7";
  S.recordGithubPull({ issueId, number: 7, url });
  S.saveGithubFeedbackObservation({
    issueId,
    kind: "issue_comment",
    githubId: 501,
    contentHash: "hash-501",
    updatedAt: "2026-06-20T10:00:00Z",
    createdAt: "2026-06-20T09:00:00Z",
    authorLogin: "octocat",
    url: `${url}#issuecomment-501`,
  });
  S.saveGithubFeedbackObservation({
    issueId,
    kind: "review",
    githubId: 502,
    contentHash: "hash-502",
    updatedAt: "2026-06-20T11:00:00Z",
    createdAt: "2026-06-20T11:00:00Z",
    authorLogin: "reviewer",
    reviewState: "approved",
    url: `${url}#pullrequestreview-502`,
  });
  // An item observed before the display columns existed: it still belongs on the timeline, placed
  // by the timestamp it does have and pointing at the PR.
  S.saveGithubFeedbackObservation({
    issueId,
    kind: "review_comment",
    githubId: 503,
    contentHash: "hash-503",
    updatedAt: "2026-06-20T12:00:00Z",
  });
  S.setGithubMerged(issueId, "2026-06-20T13:00:00Z");

  const page = await svc.pageData.pullDetail(REPO, prNumber, "me");
  const github = page.timeline.filter(
    (
      item,
    ): item is Extract<PullTimelineItemWire, { kind: "github_activity" }> =>
      item.kind === "github_activity",
  );

  expect(github.map((item) => item.github_activity)).toEqual([
    {
      type: "issue_comment",
      github_number: 7,
      github_id: 501,
      url: `${url}#issuecomment-501`,
      author: "octocat",
      review_state: null,
    },
    {
      type: "review",
      github_number: 7,
      github_id: 502,
      url: `${url}#pullrequestreview-502`,
      author: "reviewer",
      review_state: "approved",
    },
    {
      type: "review_comment",
      github_number: 7,
      github_id: 503,
      url,
      author: null,
      review_state: null,
    },
    {
      type: "merged",
      github_number: 7,
      github_id: null,
      url,
      author: null,
      review_state: null,
    },
  ]);
  // Placed by the item's own GitHub timestamp, in the one chronological order the page assembles.
  expect(github.map((item) => item.created_at)).toEqual([
    "2026-06-20T09:00:00Z",
    "2026-06-20T11:00:00Z",
    "2026-06-20T12:00:00Z",
    "2026-06-20T13:00:00Z",
  ]);
  const times = page.timeline.map((item) => Date.parse(item.created_at));
  expect([...times].sort((a, b) => a - b)).toEqual(times);

  // Unlinking the GitHub PR returns the timeline to the LoopHub-only entries it had before.
  S.deleteGithubPull(issueId);
  const unlinked = await svc.pageData.pullDetail(REPO, prNumber, "me");
  expect(
    unlinked.timeline.some((item) => item.kind === "github_activity"),
  ).toBe(false);
  expect(unlinked.timeline.length).toBe(
    (unlinked.pull.commits ?? []).length +
      unlinked.reviews.length +
      unlinked.comments.length,
  );
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

test("pullDetail の Git critical path を変更前後で計測する", async () => {
  const measure = async (parallel: boolean) => {
    const operands = await resolvePullDiffOperands(REPO, prNumber);
    const readMetadata = () =>
      Promise.all([
        svc.pulls.get(REPO, prNumber, {
          withComments: false,
          diffBaseShas: operands.baseShas,
        }),
        svc.reviews.list(REPO, prNumber),
        svc.reviews.listComments(REPO, prNumber),
        svc.comments.list(REPO, prNumber, "me"),
      ]);
    if (parallel) {
      await Promise.all([
        diffFilesBetween(operands.repoPath, operands.baseSha, operands.headSha),
        readMetadata(),
      ]);
    } else {
      await diffFilesBetween(
        operands.repoPath,
        operands.baseSha,
        operands.headSha,
      );
      await readMetadata();
    }
  };

  const before = await traceGitCommands(() => measure(false));
  const after = await traceGitCommands(() => measure(true));
  const diffCommandCount = (commands: string[]) =>
    commands.filter((command) => command.startsWith("diff ")).length;
  const beforeDiffCommands = diffCommandCount(before.commands);
  const afterDiffCommands = diffCommandCount(after.commands);

  expect(before.elapsedMs).toBeGreaterThan(0);
  expect(after.elapsedMs).toBeGreaterThan(0);
  expect(beforeDiffCommands).toBeGreaterThan(0);
  expect(afterDiffCommands).toBeGreaterThan(0);
  console.info(
    `pullDetail benchmark: sequential=${before.elapsedMs.toFixed(1)}ms/${beforeDiffCommands} diff commands, parallel=${after.elapsedMs.toFixed(1)}ms/${afterDiffCommands} diff commands`,
  );
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

test("issue pages include bounded sub-issue wire data and workflow seeds", async () => {
  const root = S.createIssue(repoId, "issue", "wire root", "", "me");
  const child = S.createIssue(repoId, "issue", "wire child", "", "me");
  const grandchild = S.createIssue(
    repoId,
    "issue",
    "wire grandchild",
    "",
    "me",
  );
  S.setIssueParent(child.id, root.id, S.nextSubIssueOrdinal(root.id));
  S.setIssueParent(grandchild.id, child.id, S.nextSubIssueOrdinal(child.id));

  const detail = await svc.pageData.issueDetail(REPO, root.number, "me");
  expect(detail.issue).toMatchObject({
    number: root.number,
    depth: 1,
    ancestors: [],
    sub_issue_summary: { total: 1, open: 1, closed: 0 },
  });
  expect(detail.issue.sub_issues).toHaveLength(1);
  expect(detail.issue.sub_issues?.[0]).toMatchObject({
    number: child.number,
    depth: 2,
    sub_issue_ordinal: 1,
    sub_issue_summary: { total: 1, open: 1, closed: 0 },
  });
  expect(detail.issue.sub_issues?.[0].sub_issues).toBeUndefined();
  expect(detail.workflow_runs).toEqual([]);

  const expanded = await svc.pageData.subIssues(REPO, root.number);
  expect(expanded).toMatchObject({ truncated: false, workflow_runs: [] });
  expect(expanded.issues).toHaveLength(1);
  expect(expanded.issues[0].number).toBe(child.number);
});
