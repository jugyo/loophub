import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-handoff-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function makePull(): Promise<number> {
  const issue = svc.issues.create("me/proj", { title: "feature" });
  const pr = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, head: "main", base: "main" },
    "sess-1",
  );
  return pr.number;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-handoff-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  svc.sessions.register({ id: "sess-1", agent: "lh-build", session: "sess-1" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("record an inline handoff: binds to PR + session, defaults hash to sha256(body)", async () => {
  const number = await makePull();
  const body = "Plan the change: add X to Y. AC: ...";
  const h = svc.handoffs.record(
    "me/proj",
    {
      phase: "plan",
      direction: "down",
      pr: number,
      from: "parent",
      to: "plan-sub",
      body,
      summary: "instruct plan sub",
    },
    "sess-1",
  );
  expect(h.seq).toBe(1);
  expect(h.phase).toBe("plan");
  expect(h.direction).toBe("down");
  expect(h.from).toBe("parent");
  expect(h.to).toBe("plan-sub");
  expect(h.pull_request).toEqual({ number });
  expect(h.session_id).toBe("sess-1");
  expect(h.body).toBe(body);
  expect(h.src).toBeNull();
  // Inline body → hash defaults to its sha256, so the record is self-verifying.
  expect(h.hash).toBe(createHash("sha256").update(body).digest("hex"));
});

test("seq increments per PR; list returns chronological order", async () => {
  const number = await makePull();
  const a = svc.handoffs.record(
    "me/proj",
    { phase: "plan", direction: "down", pr: number, body: "one" },
    "sess-1",
  );
  const b = svc.handoffs.record(
    "me/proj",
    { phase: "code", direction: "down", pr: number, body: "two" },
    "sess-1",
  );
  const c = svc.handoffs.record(
    "me/proj",
    { phase: "verify", direction: "up", pr: number, body: "three" },
    "sess-1",
  );
  expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);

  const listed = svc.handoffs.list("me/proj", { pr: number });
  expect(listed.map((h: any) => h.seq)).toEqual([1, 2, 3]);
  expect(listed.map((h: any) => h.phase)).toEqual(["plan", "code", "verify"]);
});

test("a duplicate (pr_id, seq) is rejected by the UNIQUE index (concurrency backstop)", async () => {
  const number = await makePull();
  const first = svc.handoffs.record(
    "me/proj",
    { phase: "plan", direction: "down", pr: number, body: "first" },
    "sess-1",
  );
  // A raced second writer that read the same MAX would try to INSERT the same (pr_id, seq). Simulate
  // that low-level collision with a raw insert reusing first.seq: the UNIQUE partial index must throw
  // — which is exactly what makes createHandoff's retry recompute seq instead of duplicating it.
  const S = await import("./store.ts");
  const { db, now } = await import("./db.ts");
  const repo = svc.repos.get("me/proj") as any;
  const prRow = S.getIssue(repo.id, number)!;
  expect(() =>
    db.run(
      `INSERT INTO handoffs (repo_id, pr_id, seq, phase, direction, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [repo.id, prRow.id, first.seq, "plan", "down", now()],
    ),
  ).toThrow(/UNIQUE/i);
});

test("reference handoff: src + explicit hash, no inline body", async () => {
  const number = await makePull();
  const h = svc.handoffs.record(
    "me/proj",
    {
      phase: "code",
      direction: "up",
      pr: number,
      src: "commit:abc123",
      hash: "deadbeef",
      summary: "implemented; diff in commit",
    },
    "sess-1",
  );
  expect(h.body).toBeNull();
  expect(h.src).toBe("commit:abc123");
  expect(h.hash).toBe("deadbeef");
});

test("rejects invalid direction, missing phase, and body+src together", async () => {
  const number = await makePull();
  expect(() =>
    svc.handoffs.record(
      "me/proj",
      { phase: "plan", direction: "sideways", pr: number, body: "x" },
      "sess-1",
    ),
  ).toThrow();
  expect(() =>
    svc.handoffs.record(
      "me/proj",
      { phase: "", direction: "down", pr: number, body: "x" },
      "sess-1",
    ),
  ).toThrow();
  // Body XOR src: passing both is ambiguous (inline content vs a reference).
  expect(() =>
    svc.handoffs.record(
      "me/proj",
      { phase: "plan", direction: "down", pr: number, body: "x", src: "y" },
      "sess-1",
    ),
  ).toThrow();
});

test("rejects when neither body nor src, and when neither pr nor issue", async () => {
  const number = await makePull();
  expect(() =>
    svc.handoffs.record(
      "me/proj",
      { phase: "plan", direction: "down", pr: number },
      "sess-1",
    ),
  ).toThrow();
  expect(() =>
    svc.handoffs.record(
      "me/proj",
      { phase: "plan", direction: "down", body: "x" },
      "sess-1",
    ),
  ).toThrow();
});

test("generic issue linkage: a handoff can bind to an issue, with its own seq scope", () => {
  const issue = svc.issues.create("me/proj", { title: "generic" });
  const h = svc.handoffs.record(
    "me/proj",
    { phase: "plan", direction: "down", issue: issue.number, body: "x" },
    "sess-1",
  );
  expect(h.seq).toBe(1); // per-issue counter, independent of any PR
  expect(h.issue).toEqual({ number: issue.number });
  expect(h.pull_request).toBeNull();

  const listed = svc.handoffs.list("me/proj", { issue: issue.number });
  expect(listed.map((x: any) => x.id)).toContain(h.id);
});

test("a dual-bound (pr+issue) row does not inflate a later issue-only seq counter", async () => {
  const issue = svc.issues.create("me/proj", { title: "dual" });
  const pr = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, head: "main", base: "main" },
    "sess-1",
  );
  // A handoff bound to BOTH the PR and the issue: seq is minted in the PR scope.
  const dual = svc.handoffs.record(
    "me/proj",
    {
      phase: "plan",
      direction: "down",
      pr: pr.number,
      issue: issue.number,
      body: "dual",
    },
    "sess-1",
  );
  expect(dual.pull_request).toEqual({ number: pr.number });
  expect(dual.issue).toEqual({ number: issue.number });
  // A later issue-ONLY handoff for the same issue must start its own counter at 1 (not 2): the
  // dual-bound row lives in the PR scope and must not pollute the issue-only seq scope, which is
  // exactly the rows the partial UNIQUE issue index covers (pr_id IS NULL).
  const issueOnly = svc.handoffs.record(
    "me/proj",
    { phase: "plan", direction: "up", issue: issue.number, body: "issue-only" },
    "sess-1",
  );
  expect(issueOnly.seq).toBe(1);
});

test("unregistered attribution session is not linked (FK-safe), record still succeeds", async () => {
  const number = await makePull();
  const h = svc.handoffs.record(
    "me/proj",
    { phase: "plan", direction: "down", pr: number, body: "x" },
    "not-registered-session",
  );
  expect(h.session_id).toBeNull();
});
