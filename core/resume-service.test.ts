import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { git, worktreeAdd } from "./git.ts";

// Isolate the DB + worktree root before db.ts runs its import-time setup (see AGENTS.md § Tests).
const HOME = mkdtempSync(join(tmpdir(), "lh-resume-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");
process.env.LOOPHUB_WORKTREE_ROOT = join(HOME, "worktrees");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

async function makeRepo(name: string): Promise<{ id: number; path: string }> {
  const path = mkdtempSync(join(tmpdir(), "lh-resume-repo-"));
  await git(path, ["init", "-q", "-b", "main"]);
  await git(path, ["config", "user.email", "t@t.local"]);
  await git(path, ["config", "user.name", "tester"]);
  writeFileSync(join(path, "f.txt"), "base\n");
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-qm", "base"]);
  const repo = S.createRepo(name, path, "main");
  return { id: repo.id, path };
}

// Set up the canonical `lh dev <issue>` shape: an open issue plus an open PR linked to it on branch
// loophub/issue-<n>, with the dev session attributed to the PR row (pulls.session_id). Returns the
// PR number and the Claude session id stored as the session's external_session (distinct from the
// row id to prove resolve returns external_session, the value `claude --resume` consumes).
async function devFlow(
  repo: { id: number; path: string },
  opts: {
    withBranch: boolean;
    sessionId?: string | null;
    agent?: string;
    runtime?: string | null;
  },
): Promise<{ pr: number; external: string | null }> {
  const issue = S.createIssue(repo.id, "issue", "feature", "", "me") as any;
  let external: string | null = null;
  let sessionRowId: string | null = null;
  if (opts.sessionId !== null) {
    // Issue numbers reset per repo, so key the (globally-unique) session ids by repo.id too. The
    // default external_session is UUID-shaped — `lh dev` stores the exact randomUUID it generates,
    // and resume.resolve only accepts UUID-shaped ids (isClaudeSessionId).
    sessionRowId = `row-${repo.id}-${issue.number}`;
    const tail = `${String(repo.id).padStart(6, "0")}${String(issue.number).padStart(6, "0")}`;
    external = opts.sessionId ?? `00000000-0000-4000-8000-${tail}`;
    // Default agent lh-dev with no runtime mirrors a pre-#164 session (backward-compat fallback);
    // pass agent/runtime explicitly to exercise the runtime-based path.
    S.registerAgentSession(
      sessionRowId,
      opts.agent ?? "lh-dev",
      external,
      null,
      opts.runtime ?? null,
    );
  }
  const branch = `loophub/issue-${issue.number}`;
  if (opts.withBranch) await git(repo.path, ["branch", branch, "main"]);
  const pr = S.createIssue(repo.id, "pull", "impl", "", "me") as any;
  // The dev session is attributed to the PR row (pulls.session_id) — the `lh dev <issue>` flow
  // where openPr records the session that opened the PR (#186).
  S.createPull(pr.id, branch, "main", null, issue.id, sessionRowId);
  return { pr: pr.number, external };
}

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// Happy path: resolve the linked issue's session and restore from the surviving branch.
test("resolve returns the linked-issue session and restores from the branch", async () => {
  const repo = await makeRepo("me/happy");
  const { pr, external } = await devFlow(repo, { withBranch: true });

  const res = await svc.resume.resolve("me/happy", pr);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.sessionId).toBe(external); // external_session, not the agent_sessions row id
  expect(res.issue).toBe(1); // worktree issue number from loophub/issue-1
  expect(res.branch).toBe("loophub/issue-1");
  expect(res.restore).toBe(true); // worktree absent, branch present → re-attach
  // Backward-compat: this session has runtime=NULL (registered without one), so it resolves via the
  // lh-dev → claude-code fallback and reports claude-code as the resume runtime.
  expect(res.runtime).toBe("claude-code");
});

// An explicit runtime column drives resolution directly (the modern `lh dev` path stores it).
test("resolve resumes a session with an explicit claude-code runtime", async () => {
  const repo = await makeRepo("me/explicit");
  const { pr, external } = await devFlow(repo, {
    withBranch: true,
    runtime: "claude-code",
  });

  const res = await svc.resume.resolve("me/explicit", pr);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.runtime).toBe("claude-code");
  expect(res.sessionId).toBe(external);
});

// A session whose runtime this build cannot resume (e.g. a future codex session) is reported as
// unknown-runtime — distinct from no-session — so the CLI can explain it rather than mislabel it.
test("resolve reports unknown-runtime for an unsupported runtime", async () => {
  const repo = await makeRepo("me/codex");
  const { pr } = await devFlow(repo, {
    withBranch: true,
    agent: "lh-dev",
    runtime: "codex",
  });

  const res = await svc.resume.resolve("me/codex", pr);
  expect(res).toMatchObject({
    ok: false,
    reason: "unknown-runtime",
    runtime: "codex",
  });
});

// A PR with no session recorded anywhere cannot be resumed.
test("resolve reports no-session when nothing is assigned", async () => {
  const repo = await makeRepo("me/nosess");
  const { pr } = await devFlow(repo, { withBranch: true, sessionId: null });

  const res = await svc.resume.resolve("me/nosess", pr);
  expect(res).toMatchObject({ ok: false, reason: "no-session" });
});

// Session exists but both the worktree and the branch are gone → unrestorable.
test("resolve reports unrestorable when worktree and branch are both gone", async () => {
  const repo = await makeRepo("me/gone");
  const { pr } = await devFlow(repo, { withBranch: false });

  const res = await svc.resume.resolve("me/gone", pr);
  expect(res).toMatchObject({
    ok: false,
    reason: "unrestorable",
    branch: "loophub/issue-1",
  });
});

// An existing worktree at the deterministic path is reused (restore=false).
test("resolve reuses an existing worktree", async () => {
  const repo = await makeRepo("me/reuse");
  const { pr } = await devFlow(repo, { withBranch: true });
  const wt = join(HOME, "worktrees", "me", "reuse", "issue-1");
  mkdirSync(join(HOME, "worktrees", "me", "reuse"), { recursive: true });
  await worktreeAdd(repo.path, wt, "loophub/issue-1", "main", {
    existingBranch: true,
  });

  const res = await svc.resume.resolve("me/reuse", pr);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.restore).toBe(false);

  await git(repo.path, ["worktree", "remove", "--force", wt]);
});

// A PR worked directly via `lh dev <pr>` carries the session on the PR row itself (pulls.session_id);
// resolve uses it even without a linked issue.
test("resolve uses the PR row's own session when present", async () => {
  const repo = await makeRepo("me/prself");
  const pr = S.createIssue(repo.id, "pull", "impl", "", "me") as any;
  S.registerAgentSession(
    "row-self",
    "lh-dev",
    "11111111-1111-4111-8111-111111111111",
  );
  await git(repo.path, ["branch", "loophub/issue-5", "main"]);
  S.createPull(pr.id, "loophub/issue-5", "main", null, null, "row-self");

  const res = await svc.resume.resolve("me/prself", pr.number);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.sessionId).toBe("11111111-1111-4111-8111-111111111111");
  expect(res.issue).toBe(5);
});

// A stored session id that is not a UUID (not a real Claude session) is unusable for `claude
// --resume`, so it is treated as "nothing to resume" and never reaches argv.
test("resolve treats a non-UUID stored session id as no-session", async () => {
  const repo = await makeRepo("me/badid");
  const { pr } = await devFlow(repo, {
    withBranch: true,
    sessionId: "--dangerously-skip-permissions",
  });

  const res = await svc.resume.resolve("me/badid", pr);
  expect(res).toMatchObject({ ok: false, reason: "no-session" });
});

// A PR whose session was attributed by a non-lh-dev agent (e.g. an impl-bot session) is not a Claude
// session `lh dev` launched — its external_session is that agent's own runtime id, not a Claude
// session id — so resume must not try to `claude --resume` it, even when it is UUID-shaped.
test("resolve rejects a session not registered by lh dev (wrong agent)", async () => {
  const repo = await makeRepo("me/otheragent");
  const issue = S.createIssue(repo.id, "issue", "feature", "", "me") as any;
  S.registerAgentSession(
    "row-impl",
    "impl-bot",
    "22222222-2222-4222-8222-222222222222", // valid UUID, but not lh-dev provenance
  );
  await git(repo.path, ["branch", "loophub/issue-1", "main"]);
  const pr = S.createIssue(repo.id, "pull", "impl", "", "me") as any;
  S.createPull(pr.id, "loophub/issue-1", "main", null, issue.id, "row-impl");

  const res = await svc.resume.resolve("me/otheragent", pr.number);
  expect(res).toMatchObject({ ok: false, reason: "no-session" });
});

// Through the service, re-registering a session without runtime must NOT clear a previously stored
// runtime: sessions.register passes undefined straight to the store, whose UPDATE path preserves the
// existing value (a `?? null` here would clear it, breaking resume for that session).
test("sessions.register preserves an existing runtime on re-register without runtime", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  svc.sessions.register({
    id,
    agent: "lh-dev",
    session: id,
    runtime: "claude-code",
  });
  expect(S.getAgentSession(id).runtime).toBe("claude-code");

  // Re-register the same (id, agent, session) with no runtime → existing runtime preserved.
  svc.sessions.register({ id, agent: "lh-dev", session: id });
  expect(S.getAgentSession(id).runtime).toBe("claude-code");
});
