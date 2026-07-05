import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md). #298:
// generalized session links (kind + N:M) surfaced as related_sessions on PR/issue detail.
const HOME = mkdtempSync(join(tmpdir(), "lh-sess-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

const DEV_UUID = "aaaaaaaa-0000-0000-0000-000000000001";
const REVIEW_UUID = "bbbbbbbb-0000-0000-0000-000000000002";

function assistantLine(
  id: string,
  model: string,
  usage: Record<string, number>,
) {
  return `${JSON.stringify({
    type: "assistant",
    message: { id, model, usage },
  })}\n`;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-sess-repo-"));
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

test("a dev session opened via lh dev surfaces in the PR's related_sessions and is resumable", async () => {
  const issue = svc.issues.create("me/proj", { title: "feature" });
  svc.sessions.register({
    id: DEV_UUID,
    agent: "lh-dev",
    session: DEV_UUID,
    runtime: "claude-code",
    kind: "dev",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, head: "loophub/issue-1", base: "main" },
    DEV_UUID,
  );

  const pull = (await svc.pulls.get("me/proj", opened.number)) as any;
  expect(Array.isArray(pull.related_sessions)).toBe(true);
  expect(pull.related_sessions.length).toBe(1);
  const s = pull.related_sessions[0];
  expect(s.id).toBe(DEV_UUID);
  expect(s.kind).toBe("dev");
  // The PR's primary dev session on a claude-code runtime is resumable (runtime-based judgment).
  expect(s.resume.resumable).toBe(true);
});

test("a second dev session is added (1:N) and the older one is marked superseded", async () => {
  // Re-enter the same PR with a new session: latest becomes the resume anchor, both stay listed.
  svc.sessions.register({
    id: "aaaaaaaa-0000-0000-0000-000000000099",
    agent: "lh-dev",
    session: "aaaaaaaa-0000-0000-0000-000000000099",
    runtime: "claude-code",
    kind: "dev",
  });
  await svc.dev.openPr(
    "me/proj",
    { issue: 1, head: "loophub/issue-1", base: "main" },
    "aaaaaaaa-0000-0000-0000-000000000099",
  );

  const pull = (await svc.pulls.get("me/proj", 2)) as any;
  expect(pull.related_sessions.length).toBe(2);
  const byId = Object.fromEntries(
    pull.related_sessions.map((s: any) => [s.id, s]),
  );
  // The newest (primary) is resumable; the earlier one is superseded.
  expect(byId["aaaaaaaa-0000-0000-0000-000000000099"].resume.resumable).toBe(
    true,
  );
  expect(byId[DEV_UUID].resume.resumable).toBe(false);
  expect(byId[DEV_UUID].resume.reason).toBe("superseded");
});

test("sessions.link attaches a session to an issue; issue detail lists it, resume-via-pull", () => {
  svc.sessions.register({
    id: REVIEW_UUID,
    agent: "reviewer",
    session: REVIEW_UUID,
    runtime: "claude-code",
    kind: "review",
  });
  const linked = svc.sessions.link("me/proj", {
    sessionId: REVIEW_UUID,
    issue: 1,
  });
  expect(linked.issue_number).toBe(1);

  const issue = svc.issues.get("me/proj", 1) as any;
  expect(Array.isArray(issue.related_sessions)).toBe(true);
  const s = issue.related_sessions.find((x: any) => x.id === REVIEW_UUID);
  expect(s.kind).toBe("review");
  // Issue-linked sessions are resumed via their PR, not the issue directly.
  expect(s.resume.resumable).toBe(false);
  expect(s.resume.reason).toBe("resume-via-pull");
});

test("sessions.link is idempotent and rejects ambiguous / missing targets", () => {
  // Idempotent: re-linking does not duplicate.
  svc.sessions.link("me/proj", { sessionId: REVIEW_UUID, issue: 1 });
  const list = svc.sessions.listFor("me/proj", { issue: 1 });
  expect(list.filter((x: any) => x.id === REVIEW_UUID).length).toBe(1);

  // Exactly one of issue/pr is required.
  expect(() =>
    svc.sessions.link("me/proj", { sessionId: REVIEW_UUID, issue: 1, pr: 2 }),
  ).toThrow();
  expect(() =>
    svc.sessions.link("me/proj", { sessionId: REVIEW_UUID }),
  ).toThrow();
  // Unknown session -> 404.
  expect(() =>
    svc.sessions.link("me/proj", { sessionId: "no-such", issue: 1 }),
  ).toThrow();
});

test("sessions.listFor a PR marks the primary dev session resumable", () => {
  const list = svc.sessions.listFor("me/proj", { pr: 2 });
  expect(list.length).toBe(2);
  expect(list.some((s: any) => s.resume.resumable)).toBe(true);
  expect(list[0].linked_targets).toBeUndefined();
});

test("sessions.list includes linked targets for the sessions page", () => {
  const list = svc.sessions.list() as any[];
  const review = list.find((s) => s.id === REVIEW_UUID);
  expect(review.linked_targets).toEqual([
    {
      repo: "me/proj",
      kind: "issue",
      number: 1,
      title: "feature",
      state: "open",
    },
  ]);
});

test("a session linked to a PR with no primary dev session is NOT resumable (not-anchor)", async () => {
  // Reachable via sessions.link({pr}): a PR opened without a dev session (no kind='dev' link), then a
  // non-dev session attached (sessions.link is documented as the attach point for kinds beyond dev).
  // The PR has no dev anchor (primaryDevSessionForPull → null), so `lh resume <pr>` would resolve
  // nothing and this row must not be resumable.
  const pr = (await svc.pulls.create("me/proj", {
    title: "manual PR",
    head: "manual-branch",
    base: "main",
  })) as any;
  const anchorless = "cccccccc-0000-0000-0000-000000000003";
  svc.sessions.register({
    id: anchorless,
    agent: "reviewer",
    session: anchorless,
    runtime: "claude-code",
    kind: "review",
  });
  svc.sessions.link("me/proj", { sessionId: anchorless, pr: pr.number });

  const list = svc.sessions.listFor("me/proj", { pr: pr.number });
  const s = list.find((x: any) => x.id === anchorless);
  expect(s.resume.resumable).toBe(false);
  expect(s.resume.reason).toBe("not-anchor");
});

test("an issue-create session linked to an issue is listed and resumable from the issue (#299)", () => {
  // `lh issue new` records the filing session as kind=issue-create, then `lh issue create` links it
  // to the issue it files. It has no PR/dev worktree, so it resumes directly off the issue
  // (`lh resume --session <id>`), unlike dev/review sessions which resume via their PR.
  const issue = svc.issues.create("me/proj", {
    title: "needs filing help",
  }) as any;
  const createUuid = "dddddddd-0000-0000-0000-000000000004";
  svc.sessions.register({
    id: createUuid,
    agent: "lh-issue-create",
    session: createUuid,
    runtime: "claude-code",
    kind: "issue-create",
  });
  svc.sessions.link("me/proj", { sessionId: createUuid, issue: issue.number });

  const detail = svc.issues.get("me/proj", issue.number) as any;
  const s = detail.related_sessions.find((x: any) => x.id === createUuid);
  expect(s).toBeTruthy();
  expect(s.kind).toBe("issue-create");
  // Resumable directly from the issue — no "resume-via-pull" indirection.
  expect(s.resume.resumable).toBe(true);
  expect(s.resume.reason).toBeUndefined();
});

test("resume.resolveSession resolves an issue-create session and reports failures (#299)", () => {
  const createUuid = "eeeeeeee-0000-0000-0000-000000000005";
  svc.sessions.register({
    id: createUuid,
    agent: "lh-issue-create",
    session: createUuid,
    runtime: "claude-code",
    kind: "issue-create",
  });
  // Happy path: claude-code + UUID id → resumable, returns external_session for `claude --resume`.
  expect(svc.resume.resolveSession(createUuid)).toEqual({
    ok: true,
    runtime: "claude-code",
    sessionId: createUuid,
  });
  // Unknown id → not-found.
  expect(svc.resume.resolveSession("no-such")).toMatchObject({
    ok: false,
    reason: "not-found",
  });
  // A runtime this build cannot resume → unknown-runtime (distinct from no-session).
  const codexUuid = "ffffffff-0000-0000-0000-000000000006";
  svc.sessions.register({
    id: codexUuid,
    agent: "lh-issue-create",
    session: codexUuid,
    runtime: "codex",
    kind: "issue-create",
  });
  expect(svc.resume.resolveSession(codexUuid)).toMatchObject({
    ok: false,
    reason: "unknown-runtime",
  });
});

test("sessions.usageSync imports Claude transcript usage incrementally", () => {
  const sessionId = "99999999-0000-0000-0000-000000000001";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-dev",
    session: sessionId,
    runtime: "claude-code",
    kind: "dev",
  });
  const projectsDir = mkdtempSync(join(tmpdir(), "lh-claude-projects-"));
  const projectDir = join(projectsDir, "repo-worktree");
  mkdirSync(projectDir);
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    assistantLine("msg_1", "claude-sonnet-4-6-20260601", {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 300,
      output_tokens: 10,
    }),
  );

  const first = svc.sessions.usageSync({ sessionId, projectsDir });
  expect(first).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect(first.sessions[0].messages).toBe(1);
  expect(svc.sessions.get(sessionId).usage[0]).toMatchObject({
    model: "claude-sonnet-4-6-20260601",
    input_tokens: 100,
    output_tokens: 10,
  });
  expect(svc.sessions.get(sessionId).usage[0].cost_usd).toBeCloseTo(0.000615);

  const unchanged = svc.sessions.usageSync({ sessionId, projectsDir });
  expect(unchanged).toMatchObject({ synced: 0, skipped: 1, missing: 0 });

  appendFileSync(
    transcript,
    assistantLine("msg_1", "claude-sonnet-4-6-20260601", {
      input_tokens: 1000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1000,
    }) +
      assistantLine("msg_2", "claude-sonnet-4-6-20260601", {
        input_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 3,
      }),
  );

  const second = svc.sessions.usageSync({ sessionId, projectsDir });
  expect(second.sessions[0].messages).toBe(1);
  expect(svc.sessions.get(sessionId).usage[0]).toMatchObject({
    input_tokens: 107,
    output_tokens: 13,
  });

  writeFileSync(
    transcript,
    assistantLine("msg_3", "unknown-model", {
      input_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 5,
    }),
  );
  const full = svc.sessions.usageSync({ sessionId, projectsDir, full: true });
  expect(full.sessions[0].models[0]).toMatchObject({
    model: "unknown-model",
    input_tokens: 5,
    output_tokens: 5,
    cost_usd: null,
  });

  rmSync(projectsDir, { recursive: true, force: true });
});

test("pull detail includes related session usage and an n/a aggregate for unknown costs", async () => {
  const issue = svc.issues.create("me/proj", { title: "usage on PR detail" });
  const devSessionId = "77777777-0000-0000-0000-000000000001";
  const reviewSessionId = "77777777-0000-0000-0000-000000000002";
  svc.sessions.register({
    id: devSessionId,
    agent: "lh-dev",
    session: devSessionId,
    runtime: "claude-code",
    kind: "dev",
  });
  svc.sessions.register({
    id: reviewSessionId,
    agent: "reviewer",
    session: reviewSessionId,
    runtime: "claude-code",
    kind: "review",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    {
      issue: issue.number,
      head: `loophub/issue-${issue.number}`,
      base: "main",
    },
    devSessionId,
  );
  svc.sessions.link("me/proj", {
    sessionId: reviewSessionId,
    pr: opened.number,
  });

  const projectsDir = mkdtempSync(join(tmpdir(), "lh-pr-usage-projects-"));
  const projectDir = join(projectsDir, "repo-worktree");
  mkdirSync(projectDir);
  writeFileSync(
    join(projectDir, `${devSessionId}.jsonl`),
    assistantLine("known_msg", "claude-sonnet-4-6-20260601", {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 10,
    }),
  );
  writeFileSync(
    join(projectDir, `${reviewSessionId}.jsonl`),
    assistantLine("unknown_msg", "unknown-model", {
      input_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 5,
    }),
  );

  svc.sessions.usageSync({ sessionId: devSessionId, projectsDir });
  svc.sessions.usageSync({ sessionId: reviewSessionId, projectsDir });

  const pull = (await svc.pulls.get("me/proj", opened.number)) as any;
  const dev = pull.related_sessions.find((s: any) => s.id === devSessionId);
  const review = pull.related_sessions.find(
    (s: any) => s.id === reviewSessionId,
  );
  expect(dev.usage[0]).toMatchObject({
    model: "claude-sonnet-4-6-20260601",
    input_tokens: 100,
    output_tokens: 10,
  });
  expect(review.usage[0]).toMatchObject({
    model: "unknown-model",
    input_tokens: 5,
    output_tokens: 5,
    cost_usd: null,
  });
  expect(pull.related_sessions_usage).toMatchObject({
    sessions_with_usage: 2,
    input_tokens: 105,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
    output_tokens: 15,
    total_tokens: 170,
    cost_usd: null,
    has_unknown_cost: true,
  });

  rmSync(projectsDir, { recursive: true, force: true });
});
