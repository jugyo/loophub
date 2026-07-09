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
let D: typeof import("./db.ts");
let Serialize: typeof import("./serialize.ts");

beforeAll(async () => {
  S = await import("./store.ts");
  D = await import("./db.ts");
  Serialize = await import("./serialize.ts");
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

test("deleteRepo removes PEVR runs before deleting the repo", () => {
  const repo = S.createRepo("me/pevr-remove", "/tmp/pevr-remove");
  const workflow = S.createPevrWorkflow({
    name: "repo-remove-workflow",
    description: "",
    planPrompt: "",
    executePrompt: "",
    verifyPrompt: "",
    reflectPrompt: "",
  });
  S.createPevrRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 2,
    status: "completed",
    currentStep: "reflect",
  });

  expect(S.deleteRepo("me", "pevr-remove")).toBe(true);
  expect(S.getRepo("me", "pevr-remove")).toBeNull();
});

test("updateRepo renames full_name and keeps name/owner in sync (#485)", () => {
  const repo = S.createRepo("me/rn-store", "/tmp/rn-store");

  const updated = S.updateRepo("me", "rn-store", {
    full_name: "acme/renamed-store",
  });
  expect(updated?.id).toBe(repo.id);
  expect(updated?.full_name).toBe("acme/renamed-store");
  expect(updated?.owner).toBe("acme");
  expect(updated?.name).toBe("renamed-store");

  // Old name no longer resolves; new one does, to the same row.
  expect(S.getRepo("me", "rn-store")).toBeNull();
  expect(S.getRepo("acme", "renamed-store")?.id).toBe(repo.id);
});

test("updateRepo rejects malformed full_name instead of mangling it (#485)", () => {
  S.createRepo("me/rn-guard", "/tmp/rn-guard");

  // splitName would silently truncate "a/b/c" to "a/b"; the write must refuse instead.
  expect(() => S.updateRepo("me", "rn-guard", { full_name: "a/b/c" })).toThrow(
    /invalid repo name/,
  );
  expect(() =>
    S.updateRepo("me", "rn-guard", { full_name: "../evil" }),
  ).toThrow(/invalid repo name/);
  // Control characters would poison every later derived-path fs call.
  expect(() =>
    S.updateRepo("me", "rn-guard", { full_name: "a\u0000b/app" }),
  ).toThrow(/invalid repo name/);
  expect(S.getRepo("me", "rn-guard")).not.toBeNull();
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
  S.createReview(pr.id, "rev", "PASS", "lgtm");
  expect(S.computeReviewState(pr.id)).toBe("PASSED");

  // merge closes the PR and its linked issue
  const linkedNumber = S.setMerged(pr.id, "deadbeef", "squash");
  expect(linkedNumber).toBe(issue.number);
  expect(S.getIssueById(issue.id)!.state).toBe("closed");
});

test("listIssues sorts by created_at by default and by updated_at when asked (#418, #751)", () => {
  const repo = S.createRepo("me/sort", "/tmp/sort");
  // Three open issues. Control created_at/updated_at directly so order is
  // deterministic regardless of now()'s one-second granularity. Issue #1 is the
  // oldest by creation but the most recently updated (e.g. a fresh comment);
  // issue #3 is the newest by creation.
  const a = S.createIssue(repo.id, "issue", "a", "", "me") as any; // #1
  const b = S.createIssue(repo.id, "issue", "b", "", "me") as any; // #2
  const c = S.createIssue(repo.id, "issue", "c", "", "me") as any; // #3
  const set = (id: number, created: string, updated: string) =>
    D.db.run("UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?", [
      created,
      updated,
      id,
    ]);
  set(a.id, "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z");
  set(b.id, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
  set(c.id, "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");

  const numbers = (sort?: "updated" | "created") =>
    S.listIssues(repo.id, "issue", "open", sort).map((r: any) => r.number);

  // Default/created: newest created first -> #3, #2, #1 (updated_at no longer matters).
  expect(numbers()).toEqual([3, 2, 1]);
  expect(numbers("created")).toEqual([3, 2, 1]);
  // Explicit updated still means most recently updated first -> #1 (just updated), then #3, #2.
  expect(numbers("updated")).toEqual([1, 3, 2]);
});

test("listIssues default created sort breaks created_at ties by number desc (#418, #751)", () => {
  const repo = S.createRepo("me/sort-tie", "/tmp/sort-tie");
  const a = S.createIssue(repo.id, "issue", "a", "", "me") as any; // #1
  const b = S.createIssue(repo.id, "issue", "b", "", "me") as any; // #2
  const c = S.createIssue(repo.id, "issue", "c", "", "me") as any; // #3
  // Same created_at for all three -> tie-breaker is number DESC.
  for (const i of [a, b, c]) {
    D.db.run("UPDATE issues SET created_at = ? WHERE id = ?", [
      "2026-04-01T00:00:00Z",
      i.id,
    ]);
  }
  expect(
    S.listIssues(repo.id, "issue", "open").map((r: any) => r.number),
  ).toEqual([3, 2, 1]);
  expect(
    S.listIssues(repo.id, "issue", "open", "created").map((r: any) => r.number),
  ).toEqual([3, 2, 1]);
});

test("listIssues keeps filters when using the default created sort (#751)", () => {
  const repo = S.createRepo("me/sort-filter", "/tmp/sort-filter");
  const oldOpen = S.createIssue(repo.id, "issue", "old open", "", "me") as any;
  const newestOpen = S.createIssue(
    repo.id,
    "issue",
    "newest open",
    "",
    "me",
  ) as any;
  const newestClosed = S.createIssue(
    repo.id,
    "issue",
    "newest closed",
    "",
    "me",
  ) as any;
  const newestPull = S.createIssue(
    repo.id,
    "pull",
    "newest pull",
    "",
    "me",
  ) as any;
  const set = (id: number, created: string) =>
    D.db.run("UPDATE issues SET created_at = ? WHERE id = ?", [created, id]);

  set(oldOpen.id, "2026-01-01T00:00:00Z");
  set(newestOpen.id, "2026-04-01T00:00:00Z");
  set(newestClosed.id, "2026-05-01T00:00:00Z");
  set(newestPull.id, "2026-06-01T00:00:00Z");
  S.updateIssue(newestClosed.id, { state: "closed" });

  const titles = S.listIssues(repo.id, "issue", "open").map(
    (r: any) => r.title,
  );

  expect(titles).toEqual(["newest open", "old open"]);
});

test("a PASS goes stale once the PR head advances past the passed commit", () => {
  const repo = S.createRepo("me/stale", "/tmp/stale");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // pass against the current head -> PASSED, and unchanged head keeps it
  S.createReview(pr.id, "rev", "PASS", "lgtm", "sha-1");
  expect(S.computeReviewState(pr.id)).toBe("PASSED");

  // head advances -> the pass is stale, no longer PASSED
  S.setHeadSha(pr.id, "sha-2");
  expect(S.computeReviewState(pr.id)).toBe("STALE");

  // re-passing against the new head restores PASSED
  S.createReview(pr.id, "rev", "PASS", "lgtm again", "sha-2");
  expect(S.computeReviewState(pr.id)).toBe("PASSED");
});

test("a PASS with no recorded head stays PASSED (legacy passes)", () => {
  const repo = S.createRepo("me/legacy", "/tmp/legacy");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // pass without a head_sha (pre-tracking), then head moves -> still PASSED
  S.createReview(pr.id, "rev", "PASS", "lgtm");
  S.setHeadSha(pr.id, "sha-2");
  expect(S.computeReviewState(pr.id)).toBe("PASSED");
});

test("one commit can carry several reviews distinguished by topic (#209)", () => {
  const repo = S.createRepo("me/topics", "/tmp/topics");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // Two topic-tagged reviews plus one untagged, all against the same head.
  S.createReview(pr.id, "rev", "PASS", "design lgtm", "sha-1", "design");
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

test("computeReviewGate: no reviews yet is not gathered and never clean (#427)", () => {
  const repo = S.createRepo("me/gate-none", "/tmp/gate-none");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // No substantive review (a bare COMMENT does not count).
  S.createReview(pr.id, "rev", "COMMENT", "nit", "sha-1");
  expect(S.computeReviewGate(pr.id)).toEqual({
    reviewed: false,
    allTopicsPassed: false,
  });
});

test("computeReviewGate: every topic must pass independently (#427)", () => {
  const repo = S.createRepo("me/gate-topics", "/tmp/gate-topics");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // One topic passed, another with an unresolved REQUEST_CHANGES -> blocked.
  S.createReview(pr.id, "rev", "PASS", "design lgtm", "sha-1", "design");
  S.createReview(pr.id, "rev", "REQUEST_CHANGES", "sqli", "sha-1", "security");
  expect(S.computeReviewGate(pr.id)).toEqual({
    reviewed: true,
    allTopicsPassed: false,
  });

  // Resolve the security topic with a fresh PASS -> all topics pass.
  S.createReview(pr.id, "rev", "PASS", "fixed", "sha-1", "security");
  expect(S.computeReviewGate(pr.id)).toEqual({
    reviewed: true,
    allTopicsPassed: true,
  });
});

test("computeReviewGate: a stale PASS on a topic does not pass (#427)", () => {
  const repo = S.createRepo("me/gate-stale", "/tmp/gate-stale");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  S.createReview(pr.id, "rev", "PASS", "lgtm", "sha-1", "quality");
  expect(S.computeReviewGate(pr.id)).toEqual({
    reviewed: true,
    allTopicsPassed: true,
  });

  // Head advances past the reviewed commit -> the pass is stale, not passing.
  S.setHeadSha(pr.id, "sha-2");
  expect(S.computeReviewGate(pr.id)).toEqual({
    reviewed: true,
    allTopicsPassed: false,
  });

  // Re-pass against the new head -> passes again.
  S.createReview(pr.id, "rev", "PASS", "lgtm again", "sha-2", "quality");
  expect(S.computeReviewGate(pr.id)).toEqual({
    reviewed: true,
    allTopicsPassed: true,
  });
});

test("computeReviewGate: a single untagged PASS passes (legacy single-topic)", () => {
  const repo = S.createRepo("me/gate-untagged", "/tmp/gate-untagged");
  const issue = S.createIssue(repo.id, "issue", "issue", "body", "me") as any;
  const pr = S.createIssue(repo.id, "pull", "feat", "Closes #1", "bot") as any;
  S.createPull(pr.id, "feat", "main", "sha-1", issue.id);

  // No head_sha recorded (pre-tracking pass) -> can't be stale, passes.
  S.createReview(pr.id, "rev", "PASS", "lgtm");
  expect(S.computeReviewGate(pr.id)).toEqual({
    reviewed: true,
    allTopicsPassed: true,
  });
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

test("issueJSON includes all linked PR summaries while keeping the primary first", () => {
  const repo = S.createRepo("me/detail-prs", "/tmp/detail-prs");
  const issue = S.createIssue(repo.id, "issue", "feature", "", "me") as any;
  const closed = S.createIssue(
    repo.id,
    "pull",
    "closed attempt",
    "Closes #1",
    "bot",
  ) as any;
  S.createPull(closed.id, "closed-attempt", "main", "sha-closed", issue.id);
  S.updateIssue(closed.id, { state: "closed" });
  D.db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [
    "2026-01-01T00:00:00Z",
    closed.id,
  ]);
  const merged = S.createIssue(
    repo.id,
    "pull",
    "merged attempt",
    "Closes #1",
    "bot",
  ) as any;
  S.createPull(merged.id, "merged-attempt", "main", "sha-merged", issue.id);
  S.setMerged(merged.id, "merge-sha", "squash");
  D.db.run("UPDATE pulls SET merged_at = ? WHERE issue_id = ?", [
    "2026-02-01T00:00:00Z",
    merged.id,
  ]);
  const open = S.createIssue(
    repo.id,
    "pull",
    "open attempt",
    "Closes #1",
    "bot",
  ) as any;
  S.createPull(open.id, "open-attempt", "main", "sha-open", issue.id);
  const olderClosedNumbers: number[] = [];
  for (let i = 0; i < S.MAX_LINKED_PULLS; i++) {
    const pr = S.createIssue(
      repo.id,
      "pull",
      `older closed ${i}`,
      "Closes #1",
      "bot",
    ) as any;
    S.createPull(pr.id, `older-closed-${i}`, "main", `sha-old-${i}`, issue.id);
    S.updateIssue(pr.id, { state: "closed" });
    D.db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [
      `2025-01-0${i + 1}T00:00:00Z`,
      pr.id,
    ]);
    olderClosedNumbers.unshift(pr.number);
  }

  const out = Serialize.issueJSON(issue, repo);

  expect(out.linked_pull_requests!.map((p) => p.number)).toEqual([
    open.number,
    merged.number,
    closed.number,
    ...olderClosedNumbers,
  ]);
  expect(out.linked_pull_request?.number).toBe(open.number);
  expect(out.linked_pull_requests!.length).toBe(S.MAX_LINKED_PULLS + 3);
  expect(out.linked_pull_requests!.map((p) => p.merged).slice(0, 3)).toEqual([
    false,
    true,
    false,
  ]);
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
    "lh-build",
    "ext-rt",
    null,
    "claude-code",
  );
  expect(created.created).toBe(true);
  expect(S.getAgentSession(id)!.runtime).toBe("claude-code");

  // Re-register the same (id, agent, external_session) without a runtime keeps the stored value
  // (runtime === undefined preserves it, mirroring how name is preserved).
  S.registerAgentSession(id, "lh-build", "ext-rt");
  expect(S.getAgentSession(id)!.runtime).toBe("claude-code");

  // A runtime-less insert leaves the column NULL (the pre-#164 / backward-compat shape).
  const id2 = "22222222-0000-0000-0000-000000000002";
  S.registerAgentSession(id2, "lh-build", "ext-rt-2");
  expect(S.getAgentSession(id2)!.runtime).toBeNull();
});

test("registerAgentSession persists and preserves the kind column (#298)", () => {
  const id = "33333333-0000-0000-0000-000000000001";
  const created = S.registerAgentSession(
    id,
    "lh-build",
    "ext-kind",
    null,
    "claude-code",
    "dev",
  );
  expect(created.created).toBe(true);
  expect(S.getAgentSession(id)!.kind).toBe("dev");

  // Re-register without a kind keeps the stored value (undefined preserves, like name/runtime).
  S.registerAgentSession(id, "lh-build", "ext-kind");
  expect(S.getAgentSession(id)!.kind).toBe("dev");

  // setSessionKind overwrites it in place.
  S.setSessionKind(id, "review");
  expect(S.getAgentSession(id)!.kind).toBe("review");
});

test("linkSession is idempotent and listSessionsForIssue orders newest link first (#298)", () => {
  const repo = S.createRepo("me/links", "/tmp/links");
  const issue = S.createIssue(repo.id, "issue", "i", "", "me") as any;
  const a = "44444444-0000-0000-0000-00000000000a";
  const b = "44444444-0000-0000-0000-00000000000b";
  S.registerAgentSession(a, "lh-build", "ext-a", null, "claude-code", "dev");
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
  S.registerAgentSession(s1, "lh-build", "ext-s1", null, "claude-code");

  // createPull with a session links it and stamps kind='dev'.
  S.createPull(pr.id, "p", "main", "sha1", issue.id, s1);
  expect(S.getAgentSession(s1)!.kind).toBe("dev");
  let list = S.listSessionsForIssue(pr.id);
  expect(list.map((r: any) => r.id)).toEqual([s1]);

  // Re-attributing the PR to a newer session adds it to the list (1:N, not a replacement).
  S.registerAgentSession(s2, "lh-build", "ext-s2", null, "claude-code");
  S.setPullSession(pr.id, s2);
  expect(S.getAgentSession(s2)!.kind).toBe("dev");
  list = S.listSessionsForIssue(pr.id);
  expect(list.map((r: any) => r.id).sort()).toEqual([s1, s2].sort());
  // The primary dev session (resume anchor) is derived as the latest kind='dev' link (#316).
  expect(S.primaryDevSessionForPull(pr.id)).toBe(s2);
});

test("sessionUsageTotalsForIssue aggregates tokens/cost across every linked session (#783)", () => {
  const repo = S.createRepo("me/usage-totals", "/tmp/usage-totals");
  const pr = S.createIssue(repo.id, "pull", "p", "", "bot") as any;

  // No linked session yet: null, not a zeroed-out object.
  expect(S.sessionUsageTotalsForIssue(pr.id)).toBeNull();

  const s1 = "66666666-0000-0000-0000-000000000001";
  const s2 = "66666666-0000-0000-0000-000000000002";
  S.registerAgentSession(s1, "lh-build", "ext-t1");
  S.registerAgentSession(s2, "lh-build", "ext-t2");
  S.linkSession(s1, pr.id);
  S.linkSession(s2, pr.id);

  // A linked session with no usage rows yet still yields null (row_count stays 0).
  expect(S.sessionUsageTotalsForIssue(pr.id)).toBeNull();

  S.upsertSessionUsage(s1, {
    model: "claude-sonnet-5",
    input_tokens: 10,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
    output_tokens: 3,
    cost_usd: 0.5,
  });
  S.upsertSessionUsage(s2, {
    model: "claude-opus-4-8",
    input_tokens: 20,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 5,
    output_tokens: 6,
    cost_usd: 1.5,
  });
  expect(S.sessionUsageTotalsForIssue(pr.id)).toEqual({
    total_tokens: 51,
    cost_usd: 2,
  });

  // Any linked session with an unknown (null) cost makes the combined cost unknown too, even
  // though its tokens still count toward the total.
  S.upsertSessionUsage(s2, {
    model: "claude-opus-4-8",
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
  });
  expect(S.sessionUsageTotalsForIssue(pr.id)).toEqual({
    total_tokens: 51,
    cost_usd: null,
  });
});

test("pullAgentSummary returns the primary dev session runtime and usage models (#842)", () => {
  const repo = S.createRepo("me/agent-summary", "/tmp/agent-summary");
  const pr = S.createIssue(repo.id, "pull", "p", "", "bot") as any;
  const review = "77777777-0000-0000-0000-000000000001";
  const oldDev = "77777777-0000-0000-0000-000000000002";
  const newDev = "77777777-0000-0000-0000-000000000003";

  expect(S.pullAgentSummary(pr.id)).toBeNull();

  S.registerAgentSession(
    review,
    "reviewer",
    "ext-review",
    null,
    "codex",
    "review",
  );
  S.registerAgentSession(
    oldDev,
    "lh-build",
    "ext-old",
    null,
    "claude-code",
    "dev",
  );
  S.registerAgentSession(newDev, "lh-build", "ext-new", null, "codex", "dev");
  S.linkSession(review, pr.id);
  S.linkSession(oldDev, pr.id);
  S.setPullSession(pr.id, newDev);
  S.upsertSessionUsage(oldDev, {
    model: "claude-opus-4-8",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0.01,
  });
  S.upsertSessionUsage(newDev, {
    model: "gpt-5.5",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0.01,
  });

  expect(S.pullAgentSummary(pr.id)).toEqual({
    agent: "lh-build",
    runtime: "codex",
    models: ["gpt-5.5"],
  });
});

test("sessionUsageCostForSession sums top-level cost, null when unknown or empty (#832)", () => {
  const s = "88888888-0000-0000-0000-000000000001";
  S.registerAgentSession(s, "lh-build", "ext-cost1");

  // No usage rows yet: indeterminate → null, not 0.
  expect(S.sessionUsageCostForSession(s)).toBeNull();

  S.upsertSessionUsage(s, {
    model: "claude-sonnet-5",
    input_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 4,
  });
  S.upsertSessionUsage(s, {
    model: "claude-opus-4-8",
    input_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 7.5,
  });
  expect(S.sessionUsageCostForSession(s)).toBe(11.5);

  // One unknown-cost model row makes the whole session's cost unknown (don't stop on it).
  S.upsertSessionUsage(s, {
    model: "some-unpriced-model",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
  });
  expect(S.sessionUsageCostForSession(s)).toBeNull();
});

test("hasCostStopEvent detects a dev.cost_stopped event per session/PR/repo (#832)", () => {
  const repo = S.createRepo("me/coststop", "/tmp/coststop");
  const other = S.createRepo("me/coststop2", "/tmp/coststop2");
  const sess = "aaaaaaaa-0000-0000-0000-000000000001";
  const resumed = "aaaaaaaa-0000-0000-0000-000000000002";

  expect(S.hasCostStopEvent(repo.id, 7, sess)).toBe(false);

  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: 7,
    session_id: sess,
    reason: "cost_limit_exceeded",
    cost_usd: 12,
    limit_usd: 10,
  });
  expect(S.hasCostStopEvent(repo.id, 7, sess)).toBe(true);

  // Guard is per session: a resumed dev session on the same PR is not yet stopped, so it can be
  // stopped again (a fresh budget) rather than being permanently exempt.
  expect(S.hasCostStopEvent(repo.id, 7, resumed)).toBe(false);

  // Scoped by PR number and by repo — a different PR or repo is unaffected.
  expect(S.hasCostStopEvent(repo.id, 8, sess)).toBe(false);
  expect(S.hasCostStopEvent(other.id, 7, sess)).toBe(false);

  // A different event type on the same PR/session doesn't count as a cost stop.
  S.emitEvent(other.id, "pull_request.updated", "lh-worker", {
    number: 7,
    session_id: sess,
  });
  expect(S.hasCostStopEvent(other.id, 7, sess)).toBe(false);
});

test("hasAnyCostStopEvent detects a dev.cost_stopped event per PR, any session (#863)", () => {
  const repo = S.createRepo("me/anycoststop", "/tmp/anycoststop");
  const other = S.createRepo("me/anycoststop2", "/tmp/anycoststop2");
  const sess = "bbbbbbbb-0000-0000-0000-000000000001";

  expect(S.hasAnyCostStopEvent(repo.id, 9)).toBe(false);

  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: 9,
    session_id: sess,
    reason: "cost_limit_exceeded",
    cost_usd: 15,
    limit_usd: 10,
  });
  // Unlike the per-session guard, this is session-agnostic: the PR has been stopped, full stop.
  expect(S.hasAnyCostStopEvent(repo.id, 9)).toBe(true);

  // Scoped by PR number and by repo — a different PR or repo is unaffected.
  expect(S.hasAnyCostStopEvent(repo.id, 8)).toBe(false);
  expect(S.hasAnyCostStopEvent(other.id, 9)).toBe(false);

  // A different event type on the same PR doesn't count as a cost stop.
  S.emitEvent(repo.id, "pull_request.updated", "lh-worker", { number: 10 });
  expect(S.hasAnyCostStopEvent(repo.id, 10)).toBe(false);
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

test("setRepoFavorite toggles favorite and stamps/clears favorited_at (#457)", () => {
  const repo = S.createRepo("me/fav", "/tmp/fav");
  expect(S.isFavorite(repo)).toBe(false);
  expect(repo.favorited_at).toBeNull();

  S.setRepoFavorite(repo.id, true);
  const favorited = S.getRepoById(repo.id)!;
  expect(S.isFavorite(favorited)).toBe(true);
  expect(favorited.favorited_at).not.toBeNull();

  S.setRepoFavorite(repo.id, false);
  const unfavorited = S.getRepoById(repo.id)!;
  expect(S.isFavorite(unfavorited)).toBe(false);
  expect(unfavorited.favorited_at).toBeNull();
});

test("listRepos sorts favorites first, then by insertion order (#457)", () => {
  const a = S.createRepo("me/sort-fav-a", "/tmp/sort-fav-a");
  const b = S.createRepo("me/sort-fav-b", "/tmp/sort-fav-b");
  const c = S.createRepo("me/sort-fav-c", "/tmp/sort-fav-c");
  S.setRepoFavorite(c.id, true);

  const idsAmong = (ids: number[]) =>
    S.listRepos("all")
      .map((r) => r.id)
      .filter((id) => ids.includes(id));

  expect(idsAmong([a.id, b.id, c.id])).toEqual([c.id, a.id, b.id]);
});
