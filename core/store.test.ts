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

test("registerAgentSession persists and preserves the kind column (#298)", () => {
  const id = "33333333-0000-0000-0000-000000000001";
  const created = S.registerAgentSession(
    id,
    "lh-dev",
    "ext-kind",
    null,
    "claude-code",
    "dev",
  );
  expect(created.created).toBe(true);
  expect(S.getAgentSession(id).kind).toBe("dev");

  // Re-register without a kind keeps the stored value (undefined preserves, like name/runtime).
  S.registerAgentSession(id, "lh-dev", "ext-kind");
  expect(S.getAgentSession(id).kind).toBe("dev");

  // setSessionKind overwrites it in place.
  S.setSessionKind(id, "review");
  expect(S.getAgentSession(id).kind).toBe("review");
});

test("linkSession is idempotent and listSessionsForIssue orders newest link first (#298)", () => {
  const repo = S.createRepo("me/links", "/tmp/links");
  const issue = S.createIssue(repo.id, "issue", "i", "", "me") as any;
  const a = "44444444-0000-0000-0000-00000000000a";
  const b = "44444444-0000-0000-0000-00000000000b";
  S.registerAgentSession(a, "lh-dev", "ext-a", null, "claude-code", "dev");
  S.registerAgentSession(b, "reviewer", "ext-b", null, null, "review");

  S.linkSession(a, issue.id);
  S.linkSession(b, issue.id);
  // Re-linking the same pair is a no-op (PK), not a duplicate row.
  S.linkSession(a, issue.id);

  const list = S.listSessionsForIssue(issue.id);
  expect(list.length).toBe(2);
  // Newest link first: b was linked after a.
  expect(list[0].id).toBe(b);
  expect(list[1].id).toBe(a);
  expect(list[0].kind).toBe("review");
  // linked_at is exposed for the related-sessions list ordering/display.
  expect(typeof list[0].linked_at).toBe("string");
});

test("createPull and setPullSession record the dev session in session_links (#298)", () => {
  const repo = S.createRepo("me/devsess", "/tmp/devsess");
  const issue = S.createIssue(repo.id, "issue", "i", "", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "p", "Closes #1", "bot") as any;
  const s1 = "55555555-0000-0000-0000-000000000001";
  const s2 = "55555555-0000-0000-0000-000000000002";
  S.registerAgentSession(s1, "lh-dev", "ext-s1", null, "claude-code");

  // createPull with a session links it and stamps kind='dev'.
  S.createPull(pr.id, "p", "main", "sha1", issue.id, s1);
  expect(S.getAgentSession(s1).kind).toBe("dev");
  let list = S.listSessionsForIssue(pr.id);
  expect(list.map((r: any) => r.id)).toEqual([s1]);

  // Re-attributing the PR to a newer session adds it to the list (1:N, not a replacement).
  S.registerAgentSession(s2, "lh-dev", "ext-s2", null, "claude-code");
  S.setPullSession(pr.id, s2);
  expect(S.getAgentSession(s2).kind).toBe("dev");
  list = S.listSessionsForIssue(pr.id);
  expect(list.map((r: any) => r.id).sort()).toEqual([s1, s2].sort());
  // The primary dev session (resume anchor) is derived as the latest kind='dev' link (#316).
  expect(S.primaryDevSessionForPull(pr.id)).toBe(s2);
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
