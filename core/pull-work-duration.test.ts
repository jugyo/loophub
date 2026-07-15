import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-work-duration-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let D: typeof import("./db.ts");
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

// merge() now rejects a diff-free head (#691), so a head branch created purely to exercise
// duration tracking needs at least one real commit ahead of main. Checks out `branch`, commits,
// then returns to main so the shared repoPath's checkout is left as the other tests expect it.
function commitOnBranch(branch: string) {
  git(["checkout", "-q", branch]);
  writeFileSync(join(repoPath, `${branch.replace(/\//g, "-")}.txt`), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "impl"]);
  git(["checkout", "-q", "main"]);
}

// Push a session's created_at back by `seconds`, so a duration test isn't at the mercy of how fast
// the test runs (store.now() has second resolution — a same-second start/end would round to 0).
function backdateSession(sessionId: string, seconds: number) {
  const session = S.getAgentSession(sessionId)!;
  const past = new Date(
    Date.parse(session.created_at) - seconds * 1000,
  ).toISOString();
  D.db.run(`UPDATE agent_sessions SET created_at = ? WHERE id = ?`, [
    past,
    sessionId,
  ]);
}

// Same idea as backdateSession, for issues.closed_at: pushes it back by `seconds` so it is clearly
// distinguishable from an `updated_at` a later edit sets to "now". Without this, two synchronous
// calls in the same test can land in the same store.now() second (whole-second resolution) and a
// test asserting "duration didn't change" would pass even if pullWorkDuration wrongly fell back to
// updated_at — the exact regression this guards against.
function backdateIssueClosedAt(prNumber: number, seconds: number) {
  const repoId = (S.getRepo("me", "proj") as { id: number }).id;
  const issue = S.getIssue(repoId, prNumber)!;
  const past = new Date(
    Date.parse(issue.closed_at!) - seconds * 1000,
  ).toISOString();
  D.db.run(`UPDATE issues SET closed_at = ? WHERE id = ?`, [past, issue.id]);
}

// Push the PR's first ready_for_review event back by `seconds`, so implementation/review can be
// tested as distinguishable, non-overlapping windows instead of both landing near "now".
function backdateReadyEvent(prNumber: number, seconds: number) {
  const repoId = (S.getRepo("me", "proj") as { id: number }).id;
  const row = D.db
    .query(
      `SELECT id, created_at FROM events
       WHERE repo_id = ? AND type = 'pull_request.ready_for_review'
         AND json_extract(payload, '$.number') = ?
       ORDER BY id ASC LIMIT 1`,
    )
    .get(repoId, prNumber) as { id: number; created_at: string };
  const past = new Date(
    Date.parse(row.created_at) - seconds * 1000,
  ).toISOString();
  D.db.run(`UPDATE events SET created_at = ? WHERE id = ?`, [past, row.id]);
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  D = await import("./db.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-work-duration-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("no dev session linked: work_duration falls back to N/A across the board", async () => {
  const created = (await svc.pulls.create(
    "me/proj",
    { title: "human-authored", head: "main", base: "main" },
    undefined,
  )) as any;
  // pulls.create's own response is not detail-shaped (no related_sessions/work_duration — that's
  // gated to pulls.get, see serialize.ts pullJSON `withRelatedSessions`); re-fetch via pulls.get.
  const pull = (await svc.pulls.get("me/proj", created.number)) as any;
  expect(pull.work_duration).toEqual({
    total: { seconds: null, basis: null },
    implementation: null,
    review: null,
  });
});

test("draft PR with a dev session, not yet ready: total/implementation are in_progress, review is null", async () => {
  svc.sessions.register({ id: "sess-a", agent: "lh-build", session: "sess-a" });
  const issue = svc.issues.create("me/proj", { title: "in progress" });
  const { number } = await svc.dev.openPr(
    "me/proj",
    {
      issue: issue.number,
      head: `loophub/issue-${issue.number}`,
      base: "main",
    },
    "sess-a",
  );
  backdateSession("sess-a", 120);

  const pull = (await svc.pulls.get("me/proj", number)) as any;
  expect(pull.work_duration.total.basis).toBe("in_progress");
  // Measured up to "now", so it is at least the backdated gap, and small (no long test delay).
  expect(pull.work_duration.total.seconds).toBeGreaterThanOrEqual(120);
  expect(pull.work_duration.total.seconds).toBeLessThan(130);
  expect(pull.work_duration.implementation).toEqual({
    seconds: pull.work_duration.total.seconds,
    done: false,
  });
  expect(pull.work_duration.review).toBeNull();
});

test("ready for review but not merged: total is in_review and keeps growing, implementation freezes at the ready event", async () => {
  svc.sessions.register({ id: "sess-b", agent: "lh-build", session: "sess-b" });
  const issue = svc.issues.create("me/proj", { title: "ready flow" });
  const { number } = await svc.dev.openPr(
    "me/proj",
    {
      issue: issue.number,
      head: `loophub/issue-${issue.number}`,
      base: "main",
    },
    "sess-b",
  );
  backdateSession("sess-b", 300);
  await svc.pulls.readyForReview("me/proj", number, undefined, "sess-b");

  const pull = (await svc.pulls.get("me/proj", number)) as any;
  expect(pull.work_duration.total.basis).toBe("in_review");
  // total is measured to "now" (not frozen at the ready event) — this is the round-2 fix: it used to
  // freeze here, which under-reported a PR that then sat in review for a long time.
  expect(pull.work_duration.total.seconds).toBeGreaterThanOrEqual(300);
  expect(pull.work_duration.total.seconds).toBeLessThan(310);
  expect(pull.work_duration.implementation).toEqual({
    seconds: pull.work_duration.implementation.seconds,
    done: true,
  });
  expect(pull.work_duration.implementation.seconds).toBeGreaterThanOrEqual(300);
  expect(pull.work_duration.implementation.seconds).toBeLessThan(310);
  // Review has started (ready_for_review fired) but hasn't concluded.
  expect(pull.work_duration.review.done).toBe(false);
  expect(pull.work_duration.review.seconds).toBeGreaterThanOrEqual(0);
  expect(pull.work_duration.review.seconds).toBeLessThan(10);
});

test("merged PR: total/implementation/review split into distinguishable, frozen windows", async () => {
  svc.sessions.register({ id: "sess-c", agent: "lh-build", session: "sess-c" });
  const issue = svc.issues.create("me/proj", { title: "merged flow" });
  const headRef = `loophub/issue-${issue.number}`;
  // dev.openPr only records the head ref on the row; it does not create the git branch (that is
  // the worktree's job in the real flow). merge() needs a real branch to resolve/merge, so create
  // one here.
  git(["branch", headRef, "main"]);
  commitOnBranch(headRef);
  const { number } = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, head: headRef, base: "main" },
    "sess-c",
  );
  backdateSession("sess-c", 1000);
  await svc.pulls.readyForReview("me/proj", number, undefined, "sess-c");
  // Push the ready event back so implementation (start -> ready) and review (ready -> merge) land
  // in clearly separate windows instead of both collapsing near "now": implementation ~= 600s,
  // review ~= 400s, total ~= 1000s.
  backdateReadyEvent(number, 400);
  await svc.pulls.merge("me/proj", number, "merge", "sess-c");

  const pull = (await svc.pulls.get("me/proj", number)) as any;
  expect(pull.work_duration.total.basis).toBe("merged");
  expect(pull.work_duration.total.seconds).toBeGreaterThanOrEqual(1000);
  expect(pull.work_duration.total.seconds).toBeLessThan(1010);

  expect(pull.work_duration.implementation.done).toBe(true);
  expect(pull.work_duration.implementation.seconds).toBeGreaterThanOrEqual(600);
  expect(pull.work_duration.implementation.seconds).toBeLessThan(610);

  expect(pull.work_duration.review.done).toBe(true);
  expect(pull.work_duration.review.seconds).toBeGreaterThanOrEqual(400);
  expect(pull.work_duration.review.seconds).toBeLessThan(410);
});

test("merged without ever passing through ready_for_review: implementation covers the whole span, review stays null", async () => {
  svc.sessions.register({ id: "sess-f", agent: "lh-build", session: "sess-f" });
  const headRef = "loophub/issue-no-ready";
  git(["branch", headRef, "main"]);
  commitOnBranch(headRef);
  // A plain (non-draft) pulls.create never fires pull_request.ready_for_review — it starts ready.
  const pr = (await svc.pulls.create(
    "me/proj",
    { title: "no ready event", head: headRef, base: "main" },
    "sess-f",
  )) as any;
  backdateSession("sess-f", 90);
  await svc.pulls.merge("me/proj", pr.number, "merge", "sess-f");

  const pull = (await svc.pulls.get("me/proj", pr.number)) as any;
  expect(pull.work_duration.total.basis).toBe("merged");
  expect(pull.work_duration.total.seconds).toBeGreaterThanOrEqual(90);
  expect(pull.work_duration.total.seconds).toBeLessThan(100);
  // No ready_for_review event ever fired, so implementation falls back to the PR's own end signal
  // (merged_at here) — it covers the whole span since there is no earlier signal to split on.
  expect(pull.work_duration.implementation).toEqual({
    seconds: pull.work_duration.total.seconds,
    done: true,
  });
  expect(pull.work_duration.review).toBeNull();
});

test("closed without merging: total/implementation are closed (not growing)", async () => {
  svc.sessions.register({ id: "sess-d", agent: "lh-build", session: "sess-d" });
  const issue = svc.issues.create("me/proj", { title: "abandoned flow" });
  const { number } = await svc.dev.openPr(
    "me/proj",
    {
      issue: issue.number,
      head: `loophub/issue-${issue.number}`,
      base: "main",
    },
    "sess-d",
  );
  backdateSession("sess-d", 500);
  svc.pulls.update("me/proj", number, { state: "closed" }, "sess-d");

  const first = (await svc.pulls.get("me/proj", number)) as any;
  expect(first.work_duration.total.basis).toBe("closed");
  expect(first.work_duration.total.seconds).toBeGreaterThanOrEqual(500);
  expect(first.work_duration.total.seconds).toBeLessThan(510);
  expect(first.work_duration.implementation).toEqual({
    seconds: first.work_duration.total.seconds,
    done: true,
  });
  expect(first.work_duration.review).toBeNull();

  // A closed PR's duration must not keep growing on later reads (it is not "in_progress").
  const second = (await svc.pulls.get("me/proj", number)) as any;
  expect(second.work_duration.total.seconds).toBe(
    first.work_duration.total.seconds,
  );
});

test("closed without merging: a later title/body edit does not inflate the closed duration", async () => {
  svc.sessions.register({ id: "sess-e", agent: "lh-build", session: "sess-e" });
  const issue = svc.issues.create("me/proj", {
    title: "abandoned then edited",
  });
  const { number } = await svc.dev.openPr(
    "me/proj",
    {
      issue: issue.number,
      head: `loophub/issue-${issue.number}`,
      base: "main",
    },
    "sess-e",
  );
  backdateSession("sess-e", 200);
  svc.pulls.update("me/proj", number, { state: "closed" }, "sess-e");
  // Push closed_at 100s further into the past (session start to closed_at now ~100s, not ~200s) so
  // it is unambiguously earlier than the "now" the title edit below will stamp onto updated_at —
  // otherwise both timestamps could land in the same store.now() second (whole-second resolution)
  // and this test would pass even if the "closed" basis wrongly fell back to updated_at.
  backdateIssueClosedAt(number, 100);

  const before = (await svc.pulls.get("me/proj", number)) as any;
  expect(before.work_duration.total.basis).toBe("closed");
  expect(before.work_duration.total.seconds).toBeGreaterThanOrEqual(100);
  expect(before.work_duration.total.seconds).toBeLessThan(110);

  // updated_at moves forward on a plain title edit, but closed_at (the actual basis anchor) must
  // not — this is the bug a naive updated_at-based anchor would have re-introduced. Had it, the
  // duration below would jump up to roughly the full 200s session backdate (updated_at ≈ now, not
  // the backdated closed_at), instead of staying at ~100s.
  svc.pulls.update(
    "me/proj",
    number,
    { title: "renamed after close" },
    "sess-e",
  );
  const after = (await svc.pulls.get("me/proj", number)) as any;
  expect(after.work_duration.total.basis).toBe("closed");
  expect(after.work_duration.total.seconds).toBe(
    before.work_duration.total.seconds,
  );
});

test("closed then reopened then closed again: total un-freezes on reopen and re-freezes at the new close time", async () => {
  svc.sessions.register({ id: "sess-h", agent: "lh-build", session: "sess-h" });
  const issue = svc.issues.create("me/proj", { title: "reopen flow" });
  const { number } = await svc.dev.openPr(
    "me/proj",
    {
      issue: issue.number,
      head: `loophub/issue-${issue.number}`,
      base: "main",
    },
    "sess-h",
  );
  backdateSession("sess-h", 300);
  svc.pulls.update("me/proj", number, { state: "closed" }, "sess-h");
  backdateIssueClosedAt(number, 100); // closed_at ~200s after session start

  const closedOnce = (await svc.pulls.get("me/proj", number)) as any;
  expect(closedOnce.work_duration.total.basis).toBe("closed");
  expect(closedOnce.work_duration.total.seconds).toBeGreaterThanOrEqual(200);
  expect(closedOnce.work_duration.total.seconds).toBeLessThan(210);

  // Reopen: closed_at must clear (store.ts updateIssue), so total un-freezes and resumes counting
  // from the original session start — not from the stale closed_at.
  svc.pulls.update("me/proj", number, { state: "open" }, "sess-h");
  const reopened = (await svc.pulls.get("me/proj", number)) as any;
  expect(reopened.work_duration.total.basis).toBe("in_progress");
  expect(reopened.work_duration.total.seconds).toBeGreaterThanOrEqual(300);
  expect(reopened.work_duration.total.seconds).toBeLessThan(310);

  // Close again: re-freezes at the NEW closed_at, not the one from the first close.
  svc.pulls.update("me/proj", number, { state: "closed" }, "sess-h");
  const closedAgain = (await svc.pulls.get("me/proj", number)) as any;
  expect(closedAgain.work_duration.total.basis).toBe("closed");
  expect(closedAgain.work_duration.total.seconds).toBeGreaterThanOrEqual(300);
  expect(closedAgain.work_duration.total.seconds).toBeLessThan(310);
});

test("multiple ready_for_review events (re-review after changes requested): implementation/review anchor to the FIRST event only", async () => {
  svc.sessions.register({ id: "sess-g", agent: "lh-build", session: "sess-g" });
  const issue = svc.issues.create("me/proj", { title: "re-review flow" });
  const headRef = `loophub/issue-${issue.number}`;
  git(["branch", headRef, "main"]);
  commitOnBranch(headRef);
  const { number } = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, head: headRef, base: "main" },
    "sess-g",
  );
  backdateSession("sess-g", 1000);
  await svc.pulls.readyForReview("me/proj", number, undefined, "sess-g");
  // Push the FIRST ready event back so implementation lands at a distinguishable ~600s, leaving
  // ~400s for the whole review phase (both rounds combined).
  backdateReadyEvent(number, 400);

  await svc.reviews.create(
    "me/proj",
    number,
    { event: "REQUEST_CHANGES", body: "needs fixes" },
    "sess-g",
  );
  // Second ready_for_review event (re-review after change requests) — firstReadyForReviewAt must
  // keep resolving to the first one, not this later one.
  await svc.pulls.readyForReview("me/proj", number, undefined, "sess-g");
  await svc.pulls.merge("me/proj", number, "merge", "sess-g");

  const pull = (await svc.pulls.get("me/proj", number)) as any;
  expect(pull.work_duration.total.basis).toBe("merged");
  expect(pull.work_duration.implementation.seconds).toBeGreaterThanOrEqual(600);
  expect(pull.work_duration.implementation.seconds).toBeLessThan(610);
  // Review spans from the first ready event through both review rounds, to the merge.
  expect(pull.work_duration.review.seconds).toBeGreaterThanOrEqual(400);
  expect(pull.work_duration.review.seconds).toBeLessThan(410);
});
