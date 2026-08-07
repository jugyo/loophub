import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "..", "index.ts");
const home = mkdtempSync(join(tmpdir(), "lh-pr-cli-home-"));
const repoPath = mkdtempSync(join(tmpdir(), "lh-pr-cli-repo-"));

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function lh(args: string[]) {
  const result = spawnSync(
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
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

function createPull(branch: string): number {
  git(["checkout", "-q", "-b", branch, "main"]);
  writeFileSync(join(repoPath, `${branch}.txt`), "change\n");
  git(["add", "-A"]);
  git(["commit", "-qm", `work on ${branch}`]);
  git(["checkout", "-q", "main"]);
  const created = lh([
    "pr",
    "create",
    "--repo",
    "me/proj",
    "--title",
    `PR for ${branch}`,
    "--head",
    branch,
    "--json",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  return JSON.parse(created.stdout).number;
}

beforeAll(() => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "initial\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);

  const registered = lh(["repo", "add", repoPath, "--name", "me/proj"]);
  expect(registered.exitCode, registered.stderr).toBe(0);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("lh pr create and comment return the created resource", () => {
  const number = createPull("feature-comment");
  expect(number).toBeGreaterThan(0);

  const plain = lh([
    "pr",
    "comment",
    String(number),
    "--repo",
    "me/proj",
    "--body",
    "hello",
  ]);
  expect(plain.exitCode, plain.stderr).toBe(0);
  expect(plain.stdout).toContain(`commented on PR #${number} (comment `);

  const json = lh([
    "pr",
    "comment",
    String(number),
    "--repo",
    "me/proj",
    "--body",
    "second",
    "--json",
  ]);
  expect(json.exitCode, json.stderr).toBe(0);
  const comment = JSON.parse(json.stdout);
  expect(comment).toMatchObject({ body: "second" });
  expect(comment.id).toBeGreaterThan(0);
});

test("lh pr close / reopen report the transition and the no-op", () => {
  const number = createPull("feature-state");

  const closed = lh(["pr", "close", String(number), "--repo", "me/proj"]);
  expect(closed.exitCode, closed.stderr).toBe(0);
  expect(closed.stdout).toContain(`closed PR #${number} (open -> closed)`);

  const again = lh(["pr", "close", String(number), "--repo", "me/proj"]);
  expect(again.exitCode, again.stderr).toBe(0);
  expect(again.stdout).toContain(
    `PR #${number} was already closed (no change)`,
  );

  const reopened = lh([
    "pr",
    "reopen",
    String(number),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(reopened.exitCode, reopened.stderr).toBe(0);
  expect(JSON.parse(reopened.stdout)).toMatchObject({ number, state: "open" });
});

// #2458: `review` also owns the read-only `view`, so a verb-less `lh pr review <pr>` reads like a
// listing. It used to register an empty COMMENT review, and reviews cannot be deleted.
test("lh pr review without a verb writes nothing and exits non-zero", () => {
  const number = createPull("feature-review-verb");
  const verbless = lh(["pr", "review", String(number), "--repo", "me/proj"]);
  expect(verbless.exitCode).not.toBe(0);
  expect(verbless.stdout).toContain("lh pr review submit");

  const events = lh([
    "events",
    "--repo",
    "me/proj",
    "--type",
    "pull_request.review_submitted",
    "--json",
  ]);
  expect(events.exitCode, events.stderr).toBe(0);
  expect(
    JSON.parse(events.stdout).filter(
      (event: { payload: { number: number } }) =>
        event.payload.number === number,
    ),
  ).toHaveLength(0);
});

// #1896: `pass` means every criterion passed, so a failing grade beside it contradicts the verdict.
// The submission is still recorded — the inconsistency surfaces as a warning a human can act on.
test("lh pr review soft-warns a pass contradicted by a failing grade", () => {
  const issue = lh([
    "issue",
    "create",
    "--repo",
    "me/proj",
    "--title",
    "graded issue",
    "--ac",
    "alpha",
    "--json",
  ]);
  expect(issue.exitCode, issue.stderr).toBe(0);
  const issueNumber = JSON.parse(issue.stdout).number;
  git(["checkout", "-q", "-b", "feature-rubric", "main"]);
  writeFileSync(join(repoPath, "feature-rubric.txt"), "change\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "work on feature-rubric"]);
  git(["checkout", "-q", "main"]);
  const created = lh([
    "pr",
    "create",
    "--repo",
    "me/proj",
    "--title",
    "PR for feature-rubric",
    "--head",
    "feature-rubric",
    "--issue",
    String(issueNumber),
    "--json",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  const number = JSON.parse(created.stdout).number;
  const review = lh([
    "pr",
    "review",
    "submit",
    String(number),
    "--repo",
    "me/proj",
    "--event",
    "pass",
    "--body",
    "lgtm",
    "--ac-results",
    JSON.stringify([
      {
        criterion_id: `${issueNumber}-1`,
        verdict: "fail",
        note: "missing alpha",
      },
    ]),
  ]);
  expect(review.exitCode, review.stderr).toBe(0);
  expect(review.stderr).toContain(
    "warning: event=PASS was submitted with 1 failing acceptance criterion grade(s)",
  );
  expect(review.stdout).toContain("submitted: PASS");

  const internalIdReview = lh([
    "pr",
    "review",
    "submit",
    String(number),
    "--repo",
    "me/proj",
    "--event",
    "pass",
    "--ac-results",
    JSON.stringify([{ criterion_id: 1, verdict: "pass" }]),
  ]);
  expect(internalIdReview.exitCode).not.toBe(0);
  expect(internalIdReview.stderr).toContain(
    "requires criterion_id as <issue-number>-<ac-number>",
  );
});

test("lh pr review view reads comments and review-response stays linked", () => {
  const number = createPull("feature-review-response");
  const reviewed = lh([
    "pr",
    "review",
    "submit",
    String(number),
    "--repo",
    "me/proj",
    "--event",
    "request_changes",
    "--body",
    "please fix",
    "--comments",
    JSON.stringify([
      {
        path: "feature-review-response.txt",
        line: 1,
        body: "fix this line",
      },
    ]),
    "--json",
  ]);
  expect(reviewed.exitCode, reviewed.stderr).toBe(0);
  const reviewId = JSON.parse(reviewed.stdout).id;

  const viewed = lh([
    "pr",
    "review",
    "view",
    String(number),
    "--repo",
    "me/proj",
    "--review",
    String(reviewId),
    "--json",
  ]);
  expect(viewed.exitCode, viewed.stderr).toBe(0);
  expect(JSON.parse(viewed.stdout)).toMatchObject({
    review: { id: reviewId, body: "please fix" },
    comments: [
      {
        pull_request_review_id: reviewId,
        path: "feature-review-response.txt",
        body: "fix this line",
      },
    ],
  });

  const added = lh([
    "pr",
    "review-response",
    "add",
    String(number),
    "--repo",
    "me/proj",
    "--review",
    String(reviewId),
    "--body",
    "fixed in the latest commit",
    "--json",
  ]);
  expect(added.exitCode, added.stderr).toBe(0);
  expect(JSON.parse(added.stdout)).toMatchObject({
    pull_request_review_id: reviewId,
    pull_request_review_comment_id: null,
    body: "fixed in the latest commit",
  });

  const listed = lh([
    "pr",
    "review-response",
    "list",
    String(number),
    "--repo",
    "me/proj",
    "--review",
    String(reviewId),
    "--json",
  ]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout)).toHaveLength(1);
});
