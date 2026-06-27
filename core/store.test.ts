import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before db.ts runs its import-time setup. config.ts reads env lazily,
// but db.ts builds the connection at import time, so set env then dynamic-import store.
const HOME = mkdtempSync(join(tmpdir(), "lh-store-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("./store.ts");

beforeAll(async () => {
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("createRepo normalizes slashless names to me/<name> (RETURNING row)", () => {
  const repo = S.createRepo("proj", "/tmp/proj");
  expect(repo.full_name).toBe("me/proj");
  expect(repo.owner).toBe("me");
  expect(typeof repo.id).toBe("number");
  expect(S.getRepo("me", "proj")?.id).toBe(repo.id);
});

test("issues, labels, comments, and review state round-trip through the adapter", () => {
  const repo = S.createRepo("me/app", "/tmp/app");

  const issue = S.createIssue(repo.id, "issue", "first", "body", "me") as any;
  expect(issue.number).toBe(1);

  // run(sql, params[]) array binding + label join
  S.addLabels(repo.id, issue.id, ["ready-to-build", "bug"]);
  expect(
    S.issueLabels(issue.id)
      .map((l: any) => l.name)
      .sort(),
  ).toEqual(["bug", "ready-to-build"]);

  S.createComment(issue.id, "me", "hi");
  expect(S.countComments(issue.id)).toBe(1);

  // PR + review state machine
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "abc123", issue.id);
  expect(S.computeReviewState(pr.id)).toBe(null);
  S.createReview(pr.id, "rev", "REQUEST_CHANGES", "fix it");
  expect(S.computeReviewState(pr.id)).toBe("CHANGES_REQUESTED");
  S.markChangesAddressed(pr.id, "bot");
  expect(S.computeReviewState(pr.id)).toBe("READY_FOR_RE_REVIEW");
  S.createReview(pr.id, "rev", "APPROVE", "lgtm");
  expect(S.computeReviewState(pr.id)).toBe("APPROVED");

  // merge closes the PR and its linked issue
  const linkedNumber = S.setMerged(pr.id, "deadbeef", "squash");
  expect(linkedNumber).toBe(issue.number);
  expect(S.getIssueById(issue.id).state).toBe("closed");
});

test("an APPROVE goes stale once the PR head advances past the approved commit", () => {
  const repo = S.createRepo("me/stale", "/tmp/stale");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // approve against the current head -> APPROVED, and unchanged head keeps it
  S.createReview(pr.id, "rev", "APPROVE", "lgtm", "sha-1");
  expect(S.computeReviewState(pr.id)).toBe("APPROVED");

  // head advances -> the approve is stale, no longer APPROVED
  S.setHeadSha(pr.id, "sha-2");
  expect(S.computeReviewState(pr.id)).toBe("STALE");

  // re-approving against the new head restores APPROVED
  S.createReview(pr.id, "rev", "APPROVE", "lgtm again", "sha-2");
  expect(S.computeReviewState(pr.id)).toBe("APPROVED");
});

test("an APPROVE with no recorded head stays APPROVED (legacy approves)", () => {
  const repo = S.createRepo("me/legacy", "/tmp/legacy");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // approve without a head_sha (pre-tracking), then head moves -> still APPROVED
  S.createReview(pr.id, "rev", "APPROVE", "lgtm");
  S.setHeadSha(pr.id, "sha-2");
  expect(S.computeReviewState(pr.id)).toBe("APPROVED");
});

test("one commit can carry several reviews distinguished by topic (#209)", () => {
  const repo = S.createRepo("me/topics", "/tmp/topics");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // Two topic-tagged reviews plus one untagged, all against the same head.
  S.createReview(pr.id, "rev", "APPROVE", "design lgtm", "sha-1", "design");
  S.createReview(pr.id, "rev", "REQUEST_CHANGES", "sqli", "sha-1", "security");
  S.createReview(pr.id, "rev", "COMMENT", "nit", "sha-1");

  const reviews = S.listReviews(pr.id);
  expect(reviews.map((r: any) => r.topic)).toEqual([
    "design",
    "security",
    null,
  ]);
  // All bound to the same commit -> they coexist, not overwrite.
  expect(reviews.every((r: any) => r.head_sha === "sha-1")).toBe(true);
});

test("linkedPullsForIssue caps the fan-out and orders open PRs first", () => {
  const repo = S.createRepo("me/multi", "/tmp/multi");
  const issue = S.createIssue(repo.id, "issue", "feature", "", "me") as any;

  // Historical merged PRs linked to the issue (more than the cap).
  for (let i = 0; i < 7; i++) {
    const pr = S.createIssue(repo.id, "pull", `feat-${i}`, "Closes #1", "bot");
    S.createPull(pr.id, `feat-${i}`, "main", `sha-${i}`, issue.id);
    S.setMerged(pr.id, `merge-${i}`, "squash");
  }
  // One current open PR — most relevant, must sort first.
  const open = S.createIssue(repo.id, "pull", "feat-open", "Closes #1", "bot");
  S.createPull(open.id, "feat-open", "main", "sha-open", issue.id);

  const linked = S.linkedPullsForIssue(issue.id);
  expect(linked.length).toBe(S.MAX_LINKED_PULLS); // 8 linked, capped to 6
  expect(linked[0].number).toBe(open.number); // open & unmerged first
  expect(S.linkedPullsForIssue(-1)).toEqual([]); // none -> empty array, not null
});

test("registerAgentSession conflict surfaces as an error", () => {
  S.createRepo("me/sess", "/tmp/sess");
  S.registerAgentSession(
    "11111111-0000-0000-0000-000000000001",
    "impl-bot",
    "ext-1",
    "Impl",
  );
  // same id, different pair -> CONFLICT_ID
  expect(() =>
    S.registerAgentSession(
      "11111111-0000-0000-0000-000000000001",
      "impl-bot",
      "ext-2",
    ),
  ).toThrow("CONFLICT_ID");
});

test("registerAgentSession persists and updates the runtime column", () => {
  const id = "22222222-0000-0000-0000-000000000001";
  // Insert with an explicit runtime.
  const created = S.registerAgentSession(
    id,
    "lh-dev",
    "ext-rt",
    null,
    "claude-code",
  );
  expect(created.created).toBe(true);
  expect(S.getAgentSession(id).runtime).toBe("claude-code");

  // Re-register the same (id, agent, external_session) without a runtime keeps the stored value
  // (runtime === undefined preserves it, mirroring how name is preserved).
  S.registerAgentSession(id, "lh-dev", "ext-rt");
  expect(S.getAgentSession(id).runtime).toBe("claude-code");

  // A runtime-less insert leaves the column NULL (the pre-#164 / backward-compat shape).
  const id2 = "22222222-0000-0000-0000-000000000002";
  S.registerAgentSession(id2, "lh-dev", "ext-rt-2");
  expect(S.getAgentSession(id2).runtime).toBeNull();
});

test("emitEvent persists and listEvents filters by since/order", () => {
  const repo = S.createRepo("me/ev", "/tmp/ev");
  S.emitEvent(repo.id, "issue.opened", "me", { number: 1 });
  S.emitEvent(repo.id, "issue.closed", "me", { number: 1 });
  const asc = S.listEvents(0, repo.id, 100);
  expect(asc.length).toBe(2);
  expect(asc[0].type).toBe("issue.opened");
  const desc = S.listEvents(0, repo.id, 1, undefined, "desc");
  expect(desc.length).toBe(1);
  expect(desc[0].type).toBe("issue.closed");
});
