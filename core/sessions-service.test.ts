import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Count readdirSync calls (pass-through) so the createClaudeTranscriptIndex test can assert the
// wanted-set path stats requested filenames directly instead of enumerating each project dir
// (#1119). node:fs is spread through unchanged; only readdirSync is wrapped.
const fsSpy = vi.hoisted(() => ({ readdirDirs: [] as unknown[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      fsSpy.readdirDirs.push(args[0]);
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md). #298:
// generalized session links (kind + N:M) surfaced as related_sessions on PR/issue detail.
const HOME = mkdtempSync(join(tmpdir(), "lh-sess-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let D: typeof import("./db.ts");
let SU: typeof import("./session-usage.ts");
let ST: typeof import("./store.ts");
let serialize: typeof import("./serialize.ts");
let repoPath: string;

// sessions.get was removed as a dead production export (#1632); it only wrapped a store row in
// agentSessionJSON, so tests read the serialized session detail directly through that same path.
function getSession(id: string) {
  const row = ST.getAgentSession(id);
  if (!row) throw new Error(`session not found: ${id}`);
  return serialize.agentSessionJSON(row);
}

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

function codexRollout(
  cwd: string,
  model: string,
  usage: Record<string, number>,
  opts: {
    startedAt?: string;
    id?: string;
    parentThreadId?: string;
    modelContextWindow?: number;
    lastTokenUsage?: Record<string, number>;
  } = {},
): string {
  const payload: Record<string, unknown> = {
    cwd,
    model,
    timestamp: opts.startedAt ?? new Date().toISOString(),
  };
  if (opts.id) payload.id = opts.id;
  if (opts.parentThreadId) payload.parent_thread_id = opts.parentThreadId;
  const tokenInfo: Record<string, unknown> = { total_token_usage: usage };
  if (opts.modelContextWindow)
    tokenInfo.model_context_window = opts.modelContextWindow;
  if (opts.lastTokenUsage) tokenInfo.last_token_usage = opts.lastTokenUsage;
  return [
    JSON.stringify({
      type: "session_meta",
      payload,
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: tokenInfo,
      },
    }),
  ].join("\n");
}

beforeAll(async () => {
  svc = await import("./service.ts");
  D = await import("./db.ts");
  SU = await import("./session-usage.ts");
  ST = await import("./store.ts");
  serialize = await import("./serialize.ts");
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

test("a dev session opened via lh build surfaces in the PR's related_sessions and is resumable", async () => {
  const issue = svc.issues.create("me/proj", { title: "feature" });
  svc.sessions.register({
    id: DEV_UUID,
    agent: "lh-build",
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
    agent: "lh-build",
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

test("sessions.link attaches a session to an issue; issue detail lists it, resume-via-pull", async () => {
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

  const issue = (await svc.issues.get("me/proj", 1)) as any;
  expect(Array.isArray(issue.related_sessions)).toBe(true);
  const s = issue.related_sessions.find((x: any) => x.id === REVIEW_UUID);
  expect(s.kind).toBe("review");
  // Issue-linked sessions are resumed via their PR, not the issue directly.
  expect(s.resume.resumable).toBe(false);
  expect(s.resume.reason).toBe("resume-via-pull");
});

test("sessions.link is idempotent and rejects ambiguous / missing targets", async () => {
  // Idempotent: re-linking does not duplicate.
  svc.sessions.link("me/proj", { sessionId: REVIEW_UUID, issue: 1 });
  const list = ((await svc.issues.get("me/proj", 1)) as any).related_sessions;
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

test("sessions.list includes linked targets for the sessions page", () => {
  D.db.run(
    `INSERT INTO session_usage
     (session_id, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_usd, updated_at)
     VALUES (?, ?, 0, 0, 0, 0, 0.0, ?)`,
    [REVIEW_UUID, "gpt-5", new Date().toISOString()],
  );

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

test("sessions.list excludes sessions without usage", () => {
  const noUsageSession = "eeeeeeee-0000-0000-0000-000000000010";
  const withUsageSession = "ffffffff-0000-0000-0000-000000000011";
  svc.sessions.register({
    id: noUsageSession,
    agent: "lh-build",
    session: noUsageSession,
    runtime: "claude-code",
    kind: "dev",
  });
  svc.sessions.register({
    id: withUsageSession,
    agent: "lh-build",
    session: withUsageSession,
    runtime: "claude-code",
    kind: "dev",
  });

  D.db.run(
    `INSERT INTO session_usage
     (session_id, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_usd, updated_at)
     VALUES (?, ?, 0, 0, 0, 0, 0.0, ?)`,
    [withUsageSession, "gpt-5", new Date().toISOString()],
  );

  const list = svc.sessions.list() as any[];
  expect(list.some((s) => s.id === noUsageSession)).toBe(false);
  expect(list.some((s) => s.id === withUsageSession)).toBe(true);
});

test("sessions.costSummary returns minimal per-agent period costs", () => {
  const rows = [
    {
      id: "11111111-1017-0000-0000-000000000001",
      runtime: "codex",
      createdAt: "2030-07-09T01:00:00.000Z",
      cost: 1,
    },
    {
      id: "11111111-1017-0000-0000-000000000002",
      runtime: "codex",
      createdAt: "2030-07-08T01:00:00.000Z",
      cost: 2,
    },
    {
      id: "11111111-1017-0000-0000-000000000003",
      runtime: "codex",
      createdAt: "2030-07-01T01:00:00.000Z",
      cost: 3,
    },
    {
      id: "11111111-1017-0000-0000-000000000004",
      runtime: "codex",
      createdAt: "2030-06-28T01:00:00.000Z",
      cost: 4,
    },
    {
      id: "11111111-1017-0000-0000-000000000007",
      runtime: "codex",
      createdAt: "2030-06-01T01:00:00.000Z",
      usageUpdatedAt: "2030-07-09T03:00:00.000Z",
      cost: 5,
    },
    {
      id: "11111111-1017-0000-0000-000000000005",
      runtime: "claude-code",
      createdAt: "2030-07-09T01:00:00.000Z",
      cost: null,
    },
  ] as const;

  for (const row of rows) {
    svc.sessions.register({
      id: row.id,
      agent: "lh-build",
      session: row.id,
      runtime: row.runtime,
      kind: "dev",
    });
    D.db.run(`UPDATE agent_sessions SET created_at = ? WHERE id = ?`, [
      row.createdAt,
      row.id,
    ]);
    D.db.run(
      `INSERT INTO session_usage
       (session_id, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_usd, updated_at)
       VALUES (?, ?, 0, 0, 0, 0, ?, ?)`,
      [
        row.id,
        "test-model",
        row.cost,
        "usageUpdatedAt" in row ? row.usageUpdatedAt : row.createdAt,
      ],
    );
  }

  expect(
    svc.sessions.costSummary(new Date("2030-07-09T12:00:00.000Z")),
  ).toEqual([
    {
      agent: "claude-code",
      month: null,
      week: null,
      day: null,
      tokens_per_5m_history: Array(24).fill(0),
      tokens_per_second: null,
    },
    { agent: "codex", month: 11, week: 8, day: 6 },
    { agent: "grok", month: 0, week: 0, day: 0 },
  ]);
});

test("sessions.costSummary includes grok as a coding agent", () => {
  const sessionId = "11111111-1017-0000-0000-0000000000g7";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "grok",
    kind: "dev",
  });
  D.db.run(`UPDATE agent_sessions SET created_at = ? WHERE id = ?`, [
    "2032-07-09T01:00:00.000Z",
    sessionId,
  ]);
  D.db.run(
    `INSERT INTO session_usage
     (session_id, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_usd, updated_at)
     VALUES (?, ?, 0, 0, 0, 0, ?, ?)`,
    [sessionId, "grok-4.5", 3.5, "2032-07-09T01:00:00.000Z"],
  );

  try {
    expect(
      svc.sessions.costSummary(new Date("2032-07-09T12:00:00.000Z")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "grok",
          month: 3.5,
          week: 3.5,
          day: 3.5,
        }),
      ]),
    );
  } finally {
    D.db.run(`DELETE FROM session_usage WHERE session_id = ?`, [sessionId]);
    D.db.run(`DELETE FROM agent_sessions WHERE id = ?`, [sessionId]);
  }
});

test("sessions.costSummary aggregates persisted rate history into five-minute buckets", () => {
  const observedAt = [
    "2040-07-09T11:31:00.000Z",
    "2040-07-09T11:34:00.000Z",
    "2040-07-09T11:36:00.000Z",
  ];
  try {
    D.db.run(
      `INSERT INTO session_rate_history (tokens_per_second, observed_at)
       VALUES (?, ?), (?, ?), (?, ?)`,
      [2, observedAt[0], 4, observedAt[1], 8, observedAt[2]],
    );

    const history = svc.sessions.costSummary(
      new Date("2040-07-09T11:37:30.000Z"),
    )[0].tokens_per_5m_history;

    expect(history).toHaveLength(24);
    expect(history?.slice(-3)).toEqual([0, 900, 2400]);
  } finally {
    D.db.run(
      `DELETE FROM session_rate_history WHERE observed_at IN (?, ?, ?)`,
      observedAt,
    );
  }
});

test("sessions.costSummary counts legacy build sessions as Claude Code", () => {
  const sessionId = "11111111-1017-0000-0000-000000000006";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    kind: "dev",
  });
  D.db.run(`UPDATE agent_sessions SET created_at = ? WHERE id = ?`, [
    "2031-07-09T01:00:00.000Z",
    sessionId,
  ]);
  D.db.run(
    `INSERT INTO session_usage
     (session_id, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_usd, updated_at)
     VALUES (?, ?, 0, 0, 0, 0, ?, ?)`,
    [sessionId, "test-model", 2, "2031-07-09T01:00:00.000Z"],
  );

  expect(
    svc.sessions.costSummary(new Date("2031-07-09T12:00:00.000Z")),
  ).toEqual([
    {
      agent: "claude-code",
      month: 2,
      week: 2,
      day: 2,
      tokens_per_5m_history: Array(24).fill(0),
      tokens_per_second: null,
    },
    { agent: "codex", month: 0, week: 0, day: 0 },
    { agent: "grok", month: 0, week: 0, day: 0 },
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

  const list = ((await svc.pulls.get("me/proj", pr.number)) as any)
    .related_sessions;
  const s = list.find((x: any) => x.id === anchorless);
  expect(s.resume.resumable).toBe(false);
  expect(s.resume.reason).toBe("not-anchor");
});

test("an issue-create session linked to an issue is listed and resumable from the issue (#299)", async () => {
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

  const detail = (await svc.issues.get("me/proj", issue.number)) as any;
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
    agent: "lh-build",
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
  expect(getSession(sessionId).usage![0]).toMatchObject({
    model: "claude-sonnet-4-6-20260601",
    input_tokens: 100,
    output_tokens: 10,
    context_usage_percent: 0.042,
  });
  expect(getSession(sessionId).usage![0].cost_usd).toBeCloseTo(0.000615);
  expect(
    D.db
      .query(
        `SELECT session_id, total_tokens, token_delta
         FROM session_usage_samples
         WHERE session_id = ?`,
      )
      .all(sessionId),
  ).toMatchObject([
    {
      session_id: sessionId,
      total_tokens: 430,
      token_delta: 0,
    },
  ]);

  D.db.run(
    `UPDATE session_usage SET context_usage_percent = NULL WHERE session_id = ?`,
    [sessionId],
  );
  chmodSync(transcript, 0);
  try {
    expect(() => svc.sessions.usageSync({ sessionId, projectsDir })).toThrow();
  } finally {
    chmodSync(transcript, 0o600);
  }
  expect(getSession(sessionId).usage![0]).toMatchObject({
    input_tokens: 100,
    output_tokens: 10,
    context_usage_percent: null,
  });

  const backfilled = svc.sessions.usageSync({ sessionId, projectsDir });
  expect(backfilled).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect(backfilled.sessions[0].messages).toBe(1);
  expect(getSession(sessionId).usage![0]).toMatchObject({
    context_usage_percent: 0.042,
  });

  chmodSync(transcript, 0);
  try {
    const unchanged = svc.sessions.usageSync({ sessionId, projectsDir });
    expect(unchanged).toMatchObject({ synced: 0, skipped: 1, missing: 0 });
  } finally {
    chmodSync(transcript, 0o600);
  }

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
  expect(getSession(sessionId).usage![0]).toMatchObject({
    input_tokens: 107,
    output_tokens: 13,
  });
  expect(
    D.db
      .query(
        `SELECT total_tokens, token_delta
         FROM session_usage_samples
         WHERE session_id = ?
         ORDER BY id`,
      )
      .all(sessionId),
  ).toMatchObject([
    { total_tokens: 430, token_delta: 0 },
    { total_tokens: 430, token_delta: 0 },
    { total_tokens: 430, token_delta: 0 },
    { total_tokens: 440, token_delta: 10 },
  ]);

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

test("sessions.costSummary limits token rate to in-progress dev sessions", async () => {
  const sessionId = "99999999-0000-0000-0000-0000000000ac";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "claude-code",
    kind: "dev",
  });
  const issue = svc.issues.create("me/proj", { title: "rate active pr" });
  const opened = await svc.dev.openPr(
    "me/proj",
    {
      issue: issue.number,
      head: `loophub/issue-${issue.number}`,
      base: "main",
    },
    sessionId,
  );
  D.db.run(
    `INSERT INTO session_usage_samples
       (session_id, total_tokens, token_delta, observed_at)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    [
      sessionId,
      100,
      0,
      "2026-07-10T00:00:30Z",
      sessionId,
      250,
      150,
      "2026-07-10T00:01:00Z",
    ],
  );

  const activeSummary = svc.sessions.costSummary(
    new Date("2026-07-10T00:01:00Z"),
  )[0];
  expect(activeSummary.tokens_per_second).toBe(5);
  expect(activeSummary.tokens_per_5m_history?.at(-1)).toBe(1500);

  await svc.pulls.readyForReview(
    "me/proj",
    opened.number,
    undefined,
    sessionId,
  );

  expect(
    svc.sessions.costSummary(new Date("2026-07-10T00:01:00Z"))[0],
  ).toMatchObject({
    tokens_per_second: null,
  });
});

test("sessions.costSummary counts in-progress workflow-step sessions toward the live rate", async () => {
  // Under workflow-first the token-consuming session is kind='workflow-step', not 'dev'. Its samples
  // must still feed the live TPS as long as the linked pull is open, unmerged, and not yet marked
  // ready-for-review (#1662).
  const sessionId = "99999999-0000-0000-0000-0000000000af";
  svc.sessions.register({
    id: sessionId,
    agent: "workflow-step",
    session: sessionId,
    runtime: "claude-code",
    kind: "workflow-step",
  });
  const issue = svc.issues.create("me/proj", {
    title: "rate workflow-step pr",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    undefined,
  );
  svc.sessions.link("me/proj", { sessionId, pr: opened.number });
  D.db.run(
    `INSERT INTO session_usage_samples
       (session_id, total_tokens, token_delta, observed_at)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    [
      sessionId,
      100,
      0,
      "2026-07-12T00:00:30Z",
      sessionId,
      250,
      150,
      "2026-07-12T00:01:00Z",
    ],
  );

  const activeSummary = svc.sessions.costSummary(
    new Date("2026-07-12T00:01:00Z"),
  )[0];
  expect(activeSummary.tokens_per_second).toBe(5);
  expect(activeSummary.tokens_per_5m_history?.at(-1)).toBe(1500);

  await svc.pulls.readyForReview(
    "me/proj",
    opened.number,
    undefined,
    sessionId,
  );

  expect(
    svc.sessions.costSummary(new Date("2026-07-12T00:01:00Z"))[0],
  ).toMatchObject({
    tokens_per_second: null,
  });
});

test("sessions.recordLiveRateSample persists rate that survives the 600s sample prune", async () => {
  const sessionId = "99999999-0000-0000-0000-0000000000ad";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "claude-code",
    kind: "dev",
  });
  const issue = svc.issues.create("me/proj", { title: "rate history pr" });
  await svc.dev.openPr(
    "me/proj",
    {
      issue: issue.number,
      head: `loophub/issue-${issue.number}`,
      base: "main",
    },
    sessionId,
  );
  D.db.run(
    `INSERT INTO session_usage_samples
       (session_id, total_tokens, token_delta, observed_at)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    [
      sessionId,
      100,
      0,
      "2026-07-11T00:00:30Z",
      sessionId,
      250,
      150,
      "2026-07-11T00:01:00Z",
    ],
  );

  const now = new Date("2026-07-11T00:01:00Z");
  expect(svc.sessions.recordLiveRateSample(now)).toBe(5);

  const history = D.db
    .query(
      `SELECT tokens_per_second, observed_at FROM session_rate_history ORDER BY observed_at`,
    )
    .all() as { tokens_per_second: number; observed_at: string }[];
  expect(history).toHaveLength(1);
  expect(history[0].tokens_per_second).toBe(5);

  // Simulate the 600s sample prune running ~10 min later, once both source samples have aged out: it
  // must actually delete them (proving the source rate data is gone) while the persisted rate history
  // survives in its separate, prune-resistant table.
  const laterPrune = new Date("2026-07-11T00:11:30Z");
  D.db.run(`DELETE FROM session_usage_samples WHERE observed_at < ?`, [
    new Date(laterPrune.getTime() - 600 * 1000).toISOString(),
  ]);
  const samplesLeft = D.db
    .query(
      `SELECT COUNT(*) AS n FROM session_usage_samples WHERE session_id = ?`,
    )
    .get(sessionId) as { n: number };
  expect(samplesLeft.n).toBe(0);
  const remaining = D.db
    .query(`SELECT COUNT(*) AS n FROM session_rate_history`)
    .get() as { n: number };
  expect(remaining.n).toBe(1);
});

test("sessions.recordLiveRateSample writes nothing when there is no active rate", () => {
  const before = (
    D.db.query(`SELECT COUNT(*) AS n FROM session_rate_history`).get() as {
      n: number;
    }
  ).n;
  expect(
    svc.sessions.recordLiveRateSample(new Date("2027-01-01T00:00:00Z")),
  ).toBeNull();
  const after = (
    D.db.query(`SELECT COUNT(*) AS n FROM session_rate_history`).get() as {
      n: number;
    }
  ).n;
  expect(after).toBe(before);
});

test("sessions.usageSync does not repeatedly backfill unavailable Claude context", () => {
  const sessionId = "99999999-0000-0000-0000-0000000000bf";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "claude-code",
    kind: "dev",
  });
  const projectsDir = mkdtempSync(join(tmpdir(), "lh-claude-null-context-"));
  const projectDir = join(projectsDir, "repo-worktree");
  mkdirSync(projectDir);
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    assistantLine("msg_1", "claude-sonnet-4-6-20260601", {
      output_tokens: 10,
    }),
  );

  const first = svc.sessions.usageSync({ sessionId, projectsDir });
  expect(first).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect(getSession(sessionId).usage![0]).toMatchObject({
    model: "claude-sonnet-4-6-20260601",
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 10,
    context_usage_percent: null,
  });

  chmodSync(transcript, 0);
  try {
    const unchanged = svc.sessions.usageSync({ sessionId, projectsDir });
    expect(unchanged).toMatchObject({ synced: 0, skipped: 1, missing: 0 });
  } finally {
    chmodSync(transcript, 0o600);
  }

  rmSync(projectsDir, { recursive: true, force: true });
});

test("sessions.usageSync imports Claude sidechain usage as subagent detail", () => {
  const sessionId = "99999999-0000-0000-0000-0000000000cc";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-pr-review",
    session: sessionId,
    runtime: "claude-code",
    kind: "review",
  });
  const projectsDir = mkdtempSync(join(tmpdir(), "lh-claude-subagents-"));
  const projectDir = join(projectsDir, "repo-worktree");
  const subagentDir = join(projectDir, sessionId, "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    assistantLine("parent_msg", "claude-sonnet-4-6-20260601", {
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 10,
      output_tokens: 5,
    }),
  );
  const subagentPath = join(subagentDir, "agent-security.jsonl");
  writeFileSync(
    subagentPath,
    [
      JSON.stringify({
        type: "user",
        isSidechain: true,
        agentId: "agent-security",
        sessionId,
        message: { content: "Role: Security reviewer\nReview only." },
      }),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "agent-security",
        attributionAgent: "general-purpose",
        message: {
          id: "sub_msg",
          model: "claude-haiku-3-5-20241022",
          usage: {
            input_tokens: 20,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
          },
        },
      }),
    ].join("\n"),
  );

  const synced = svc.sessions.usageSync({ sessionId, projectsDir });
  expect(synced).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect(synced.sessions[0].messages).toBe(2);
  const session = getSession(sessionId) as any;
  expect(session.usage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "claude-sonnet-4-6-20260601",
        input_tokens: 100,
      }),
      expect.objectContaining({
        model: "claude-haiku-3-5-20241022",
        input_tokens: 20,
      }),
    ]),
  );
  expect(session.subagent_usage[0]).toMatchObject({
    source_id: "agent-security",
    parent_source_id: sessionId,
    label: "Security reviewer",
    kind: "claude-sidechain",
    model: "claude-haiku-3-5-20241022",
    input_tokens: 20,
    output_tokens: 4,
    context_usage_percent: 0.0125,
  });

  D.db.run(
    `UPDATE session_usage_subagents SET context_usage_percent = NULL WHERE session_id = ?`,
    [sessionId],
  );
  const backfilled = svc.sessions.usageSync({ sessionId, projectsDir });
  expect(backfilled).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect((getSession(sessionId) as any).subagent_usage[0]).toMatchObject({
    context_usage_percent: 0.0125,
  });

  chmodSync(subagentPath, 0);
  try {
    const unchanged = svc.sessions.usageSync({ sessionId, projectsDir });
    expect(unchanged).toMatchObject({ synced: 0, skipped: 1, missing: 0 });
  } finally {
    chmodSync(subagentPath, 0o600);
  }

  rmSync(projectsDir, { recursive: true, force: true });
});

test("sessions.usageSync imports Codex rollouts for the linked PR worktree cwd", async () => {
  const issue = svc.issues.create("me/proj", { title: "codex usage" });
  const sessionId = "99999999-0000-0000-0000-0000000000cd";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "codex",
    kind: "dev",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    sessionId,
  );
  const rolloutStartedAt = new Date().toISOString();
  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${opened.number}`);
  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-sessions-"));
  const dayDir = join(codexSessionsDir, "2026", "07", "05");
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, "rollout-main.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 5,
        reasoning_output_tokens: 5,
      },
      {
        startedAt: rolloutStartedAt,
        id: "root-thread",
      },
    ),
  );
  writeFileSync(
    join(dayDir, "rollout-subagent.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 30,
        cached_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 1,
      },
      {
        startedAt: rolloutStartedAt,
        id: "subagent-thread",
        parentThreadId: "root-thread",
      },
    ),
  );
  writeFileSync(
    join(dayDir, "rollout-peer-root.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 40,
        cached_input_tokens: 10,
        output_tokens: 3,
      },
      {
        startedAt: rolloutStartedAt,
        id: "peer-root-thread",
      },
    ),
  );
  writeFileSync(
    join(dayDir, "rollout-other-cwd.jsonl"),
    codexRollout(
      "/tmp/other-worktree",
      "gpt-5.5",
      {
        input_tokens: 1000,
        cached_input_tokens: 0,
        output_tokens: 1000,
      },
      {
        startedAt: rolloutStartedAt,
        id: "other-cwd-thread",
      },
    ),
  );

  const first = svc.sessions.usageSync({ sessionId, codexSessionsDir });
  expect(first).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect(first.sessions[0].messages).toBe(3);
  expect(getSession(sessionId).usage![0]).toMatchObject({
    model: "gpt-5.5",
    input_tokens: 140,
    cache_read_input_tokens: 30,
    output_tokens: 10,
  });
  expect(getSession(sessionId).usage![0].cost_usd).toBeCloseTo(0.001015);
  expect((getSession(sessionId) as any).subagent_usage[0]).toMatchObject({
    source_id: "subagent-thread",
    parent_source_id: "root-thread",
    label: "Codex thread subagent-thread",
    kind: "codex-child-rollout",
    model: "gpt-5.5",
    input_tokens: 30,
    output_tokens: 2,
  });
  D.db.run(`DELETE FROM session_usage_subagents WHERE session_id = ?`, [
    sessionId,
  ]);
  const backfilled = svc.sessions.usageSync({ sessionId, codexSessionsDir });
  expect(backfilled).toMatchObject({ synced: 0, skipped: 1, missing: 0 });
  expect((getSession(sessionId) as any).subagent_usage[0]).toMatchObject({
    source_id: "subagent-thread",
    parent_source_id: "root-thread",
    kind: "codex-child-rollout",
    input_tokens: 30,
    output_tokens: 2,
  });

  const rolloutFiles = [
    join(dayDir, "rollout-main.jsonl"),
    join(dayDir, "rollout-subagent.jsonl"),
    join(dayDir, "rollout-peer-root.jsonl"),
    join(dayDir, "rollout-other-cwd.jsonl"),
  ];
  writeFileSync(
    join(dayDir, "rollout-subagent.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 35,
        cached_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 1,
      },
      {
        startedAt: rolloutStartedAt,
        id: "subagent-thread",
        parentThreadId: "root-thread",
      },
    ),
  );
  writeFileSync(
    join(dayDir, "rollout-peer-root.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 35,
        cached_input_tokens: 10,
        output_tokens: 3,
      },
      {
        startedAt: rolloutStartedAt,
        id: "peer-root-thread",
      },
    ),
  );
  const changedMtime = new Date(Date.now() + 5000);
  utimesSync(
    join(dayDir, "rollout-subagent.jsonl"),
    changedMtime,
    changedMtime,
  );
  utimesSync(
    join(dayDir, "rollout-peer-root.jsonl"),
    changedMtime,
    changedMtime,
  );
  const detailChanged = svc.sessions.usageSync({ sessionId, codexSessionsDir });
  expect(detailChanged).toMatchObject({ synced: 0, skipped: 1, missing: 0 });
  expect((getSession(sessionId) as any).subagent_usage[0]).toMatchObject({
    source_id: "subagent-thread",
    input_tokens: 35,
    output_tokens: 2,
  });

  for (const file of rolloutFiles) chmodSync(file, 0);
  try {
    const unchanged = svc.sessions.usageSync({ sessionId, codexSessionsDir });
    expect(unchanged).toMatchObject({ synced: 0, skipped: 1, missing: 0 });
  } finally {
    for (const file of rolloutFiles) chmodSync(file, 0o600);
  }

  const full = svc.sessions.usageSync({
    sessionId,
    codexSessionsDir,
    full: true,
  });
  expect(full.sessions[0].models[0]).toMatchObject({
    input_tokens: 140,
    output_tokens: 10,
  });

  for (const file of rolloutFiles) rmSync(file, { force: true });
  const missing = svc.sessions.usageSync({ sessionId, codexSessionsDir });
  expect(missing).toMatchObject({ synced: 0, skipped: 0, missing: 1 });
  expect(getSession(sessionId).usage ?? []).toEqual([]);
  expect((getSession(sessionId) as any).subagent_usage ?? []).toEqual([]);

  rmSync(codexSessionsDir, { recursive: true, force: true });
});

function grokUpdatesJsonl(
  prompts: {
    promptId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens?: number;
    reasoningTokens?: number;
    apiDurationMs?: number;
  }[],
): string {
  return prompts
    .map((p) =>
      JSON.stringify({
        method: "_x.ai/session/update",
        params: {
          sessionId: "grok-session",
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: p.promptId,
            usage: {
              inputTokens: p.inputTokens,
              outputTokens: p.outputTokens,
              cachedReadTokens: p.cachedReadTokens ?? 0,
              reasoningTokens: p.reasoningTokens ?? 0,
              ...(p.apiDurationMs != null
                ? { apiDurationMs: p.apiDurationMs }
                : {}),
              modelUsage: {
                [p.model]: {
                  inputTokens: p.inputTokens,
                  outputTokens: p.outputTokens,
                  cachedReadTokens: p.cachedReadTokens ?? 0,
                  reasoningTokens: p.reasoningTokens ?? 0,
                },
              },
            },
          },
        },
      }),
    )
    .join("\n");
}

test("sessions.usageSync imports Grok updates.jsonl for the linked PR worktree cwd", async () => {
  const issue = svc.issues.create("me/proj", { title: "grok usage" });
  const sessionId = "99999999-0000-0000-0000-0000000000g1";
  const peerId = "99999999-0000-0000-0000-0000000000g2";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "grok",
    kind: "dev",
  });
  svc.sessions.register({
    id: peerId,
    agent: "workflow-step",
    session: peerId,
    runtime: "grok",
    kind: "workflow-step",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    sessionId,
  );
  svc.sessions.link("me/proj", { sessionId: peerId, pr: opened.number });

  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${opened.number}`);
  const grokSessionsDir = mkdtempSync(join(tmpdir(), "lh-grok-sessions-"));
  const cwdDir = join(grokSessionsDir, encodeURIComponent(worktree));
  const otherCwdDir = join(
    grokSessionsDir,
    encodeURIComponent("/tmp/other-worktree"),
  );
  mkdirSync(join(cwdDir, "grok-sess-a"), { recursive: true });
  mkdirSync(join(cwdDir, "grok-sess-b"), { recursive: true });
  mkdirSync(join(otherCwdDir, "grok-other"), { recursive: true });
  writeFileSync(
    join(cwdDir, "grok-sess-a", "updates.jsonl"),
    grokUpdatesJsonl([
      {
        promptId: "p1",
        model: "grok-4.5",
        inputTokens: 1000,
        outputTokens: 40,
        cachedReadTokens: 200,
        reasoningTokens: 10,
      },
    ]),
  );
  writeFileSync(
    join(cwdDir, "grok-sess-b", "updates.jsonl"),
    grokUpdatesJsonl([
      {
        promptId: "p2",
        model: "grok-code-fast-1",
        inputTokens: 100,
        outputTokens: 5,
      },
    ]),
  );
  writeFileSync(
    join(otherCwdDir, "grok-other", "updates.jsonl"),
    grokUpdatesJsonl([
      {
        promptId: "p-other",
        model: "grok-4.5",
        inputTokens: 99999,
        outputTokens: 999,
      },
    ]),
  );

  const first = svc.sessions.usageSync({ sessionId, grokSessionsDir });
  expect(first).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  // Owner (primary dev) stores the worktree aggregate; peer is cleared.
  const ownerUsage = getSession(sessionId).usage ?? [];
  expect(ownerUsage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "grok-4.5",
        input_tokens: 800,
        cache_read_input_tokens: 200,
        output_tokens: 50,
      }),
      expect.objectContaining({
        model: "grok-code-fast-1",
        input_tokens: 100,
        output_tokens: 5,
      }),
    ]),
  );
  const grok45 = ownerUsage.find((u) => u.model === "grok-4.5")!;
  expect(grok45.cost_usd).not.toBeNull();
  expect(grok45.cost_usd).toBeCloseTo(
    (800 * 2 + 200 * 0.5 + 50 * 6) / 1_000_000,
  );
  expect(getSession(peerId).usage ?? []).toEqual([]);

  // Unchanged re-sync is skipped.
  const second = svc.sessions.usageSync({ sessionId, grokSessionsDir });
  expect(second).toMatchObject({ synced: 0, skipped: 1, missing: 0 });

  // Unknown model keeps tokens with null cost.
  writeFileSync(
    join(cwdDir, "grok-sess-a", "updates.jsonl"),
    grokUpdatesJsonl([
      {
        promptId: "p-unknown",
        model: "grok-unknown-future",
        inputTokens: 50,
        outputTokens: 5,
      },
    ]),
  );
  writeFileSync(join(cwdDir, "grok-sess-b", "updates.jsonl"), "");
  const unknown = svc.sessions.usageSync({
    sessionId,
    grokSessionsDir,
    full: true,
  });
  expect(unknown).toMatchObject({ synced: 1 });
  expect(getSession(sessionId).usage![0]).toMatchObject({
    model: "grok-unknown-future",
    input_tokens: 50,
    output_tokens: 5,
    cost_usd: null,
  });

  rmSync(grokSessionsDir, { recursive: true, force: true });
});

test("sessions.usageSync reconstructs Grok turn rate samples for live TPS", async () => {
  const issue = svc.issues.create("me/proj", { title: "grok tps" });
  const sessionId = "99999999-0000-0000-0000-0000000000g3";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "grok",
    kind: "dev",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    sessionId,
  );

  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${opened.number}`);
  const grokSessionsDir = mkdtempSync(join(tmpdir(), "lh-grok-tps-"));
  const cwdDir = join(grokSessionsDir, encodeURIComponent(worktree));
  mkdirSync(join(cwdDir, "grok-sess"), { recursive: true });

  // 1500 mapped tokens (no cache/reasoning) over 10s → 150 TPS after first turn.
  writeFileSync(
    join(cwdDir, "grok-sess", "updates.jsonl"),
    grokUpdatesJsonl([
      {
        promptId: "p1",
        model: "grok-4.5",
        inputTokens: 1000,
        outputTokens: 500,
        apiDurationMs: 10_000,
      },
    ]),
  );

  const synced = svc.sessions.usageSync({ sessionId, grokSessionsDir });
  expect(synced).toMatchObject({ synced: 1, skipped: 0, missing: 0 });

  const samples = D.db
    .query(
      `SELECT total_tokens, token_delta, observed_at
       FROM session_usage_samples
       WHERE session_id = ?
       ORDER BY observed_at, id`,
    )
    .all(sessionId) as {
    total_tokens: number;
    token_delta: number;
    observed_at: string;
  }[];
  expect(samples).toHaveLength(2);
  expect(samples[0]).toMatchObject({ total_tokens: 0, token_delta: 0 });
  expect(samples[1]).toMatchObject({ total_tokens: 1500, token_delta: 1500 });
  expect(samples[1].token_delta).toBeGreaterThan(0);

  // Reconstruct rate from this session's samples only (costSummary aggregates every
  // in-progress dev session in the shared test DB).
  const rateNow = new Date(samples[1].observed_at);
  const { calculateTokensPerSecond } = await import("./session-usage-rate.ts");
  expect(
    calculateTokensPerSecond(
      samples.map((sample) => ({
        session_id: sessionId,
        total_tokens: sample.total_tokens,
        token_delta: sample.token_delta,
        observed_at: sample.observed_at,
      })),
      { now: rateNow },
    ),
  ).toBe(150);
  // Status-bar path must also see a non-null live rate while this PR is in progress.
  const summary = svc.sessions.costSummary(rateNow)[0];
  expect(summary.tokens_per_second).not.toBeNull();
  expect(summary.tokens_per_second!).toBeGreaterThan(0);

  // Cost columns stay single-counted (one upsert path only).
  const usage = getSession(sessionId).usage ?? [];
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    model: "grok-4.5",
    input_tokens: 1000,
    output_tokens: 500,
  });
  expect(usage[0].cost_usd).toBeCloseTo((1000 * 2 + 500 * 6) / 1_000_000);

  rmSync(grokSessionsDir, { recursive: true, force: true });
});

test("sessions.usageSync clears stale Codex usage when no PR worktree target resolves", () => {
  const sessionId = "99999999-0000-0000-0000-0000000000e1";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "codex",
    kind: "dev",
  });
  D.db.run(
    `INSERT INTO session_usage
     (session_id, model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, cost_usd, updated_at)
     VALUES (?, ?, 100, 0, 0, 10, 0.01, ?)`,
    [sessionId, "gpt-5.5", new Date().toISOString()],
  );

  const result = svc.sessions.usageSync({ sessionId });
  expect(result).toMatchObject({ synced: 0, skipped: 0, missing: 1 });
  expect(result.sessions[0].models).toEqual([]);
  expect(getSession(sessionId).usage ?? []).toEqual([]);
});

test("sessions.usageSync records one Codex worktree aggregate for hundreds of linked sessions", async () => {
  const issue = svc.issues.create("me/proj", { title: "many codex sessions" });
  const sessionCount = 200;
  const sessionIds = Array.from(
    { length: sessionCount },
    (_, i) => `88888888-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
  );

  for (const sessionId of sessionIds) {
    svc.sessions.register({
      id: sessionId,
      agent: "lh-build",
      session: sessionId,
      runtime: "codex",
      kind: "dev",
    });
  }
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    sessionIds[0],
  );
  for (const sessionId of sessionIds.slice(1)) {
    svc.sessions.link("me/proj", { sessionId, pr: opened.number });
  }

  const baseMs = Date.parse("2026-07-05T01:00:00.000Z");
  for (const [i, sessionId] of sessionIds.entries()) {
    D.db.run(`UPDATE agent_sessions SET created_at = ? WHERE id = ?`, [
      new Date(baseMs + i * 1000).toISOString(),
      sessionId,
    ]);
  }

  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${opened.number}`);
  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-many-"));
  const dayDir = join(codexSessionsDir, "2026", "07", "05");
  mkdirSync(dayDir, { recursive: true });
  const rolloutFiles: string[] = [];
  for (let i = 0; i < sessionCount; i++) {
    const file = join(dayDir, `rollout-many-${i}.jsonl`);
    rolloutFiles.push(file);
    writeFileSync(
      file,
      codexRollout(
        worktree,
        "gpt-5.5",
        {
          input_tokens: 10 + i,
          cached_input_tokens: 0,
          output_tokens: 1,
        },
        {
          startedAt: new Date(baseMs + i * 1000 + 100).toISOString(),
          id: `root-${i}`,
        },
      ),
    );
  }

  try {
    const first = svc.sessions.usageSync({ codexSessionsDir });
    const firstStatuses = first.sessions.filter((x: any) =>
      sessionIds.includes(x.session_id),
    );
    expect(firstStatuses).toHaveLength(sessionCount);
    expect(
      firstStatuses.filter((x: any) => x.status === "updated"),
    ).toHaveLength(1);
    expect(
      firstStatuses.filter((x: any) => x.status === "skipped"),
    ).toHaveLength(sessionCount - 1);
    const primarySessionId = sessionIds[sessionIds.length - 1];
    expect(getSession(primarySessionId).usage![0]).toMatchObject({
      input_tokens: 21900,
      output_tokens: 200,
    });
    expect(getSession(sessionIds[0]).usage ?? []).toEqual([]);

    for (const file of rolloutFiles) chmodSync(file, 0);
    const second = svc.sessions.usageSync({ codexSessionsDir });
    const secondStatuses = second.sessions.filter((x: any) =>
      sessionIds.includes(x.session_id),
    );
    expect(secondStatuses.every((x: any) => x.status === "skipped")).toBe(true);
  } finally {
    for (const file of rolloutFiles) chmodSync(file, 0o600);
    rmSync(codexSessionsDir, { recursive: true, force: true });
  }
});

test("sessions.usageSync keeps multiple same-worktree Codex roots aggregated", async () => {
  const issue = svc.issues.create("me/proj", {
    title: "multi-root codex usage",
  });
  const sessionId = "99999999-0000-0000-0000-0000000000ce";
  svc.sessions.register({
    id: sessionId,
    agent: "lh-build",
    session: sessionId,
    runtime: "codex",
    kind: "dev",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    sessionId,
  );
  const rolloutStartedAt = new Date().toISOString();
  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${opened.number}`);
  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-ambiguous-"));
  const dayDir = join(codexSessionsDir, "2026", "07", "05");
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, "rollout-root-a.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 1,
      },
      { startedAt: rolloutStartedAt, id: "root-a" },
    ),
  );

  const first = svc.sessions.usageSync({ sessionId, codexSessionsDir });
  expect(first).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect(getSession(sessionId).usage![0]).toMatchObject({
    input_tokens: 10,
    output_tokens: 1,
  });

  writeFileSync(
    join(dayDir, "rollout-root-b.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 20,
        cached_input_tokens: 0,
        output_tokens: 2,
      },
      { startedAt: rolloutStartedAt, id: "root-b" },
    ),
  );

  const result = svc.sessions.usageSync({ sessionId, codexSessionsDir });
  expect(result).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect(getSession(sessionId).usage![0]).toMatchObject({
    input_tokens: 30,
    output_tokens: 3,
  });

  rmSync(codexSessionsDir, { recursive: true, force: true });
});

test("sessions.usageSync sums all Codex rollouts in the PR worktree without peer windows", async () => {
  const issue = svc.issues.create("me/proj", { title: "codex worktree total" });
  const firstSessionId = "99999999-0000-0000-0000-0000000000d1";
  const secondSessionId = "99999999-0000-0000-0000-0000000000d2";
  svc.sessions.register({
    id: firstSessionId,
    agent: "lh-build",
    session: firstSessionId,
    runtime: "codex",
    kind: "dev",
  });
  svc.sessions.register({
    id: secondSessionId,
    agent: "reviewer",
    session: secondSessionId,
    runtime: "codex",
    kind: "review",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    firstSessionId,
  );
  svc.sessions.link("me/proj", {
    sessionId: secondSessionId,
    pr: opened.number,
  });
  D.db.run(`UPDATE agent_sessions SET created_at = ? WHERE id = ?`, [
    "2026-07-05T00:00:00Z",
    firstSessionId,
  ]);
  D.db.run(`UPDATE agent_sessions SET created_at = ? WHERE id = ?`, [
    "2026-07-05T00:00:02Z",
    secondSessionId,
  ]);

  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${opened.number}`);
  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-child-"));
  const dayDir = join(codexSessionsDir, "2026", "07", "05");
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, "rollout-root.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 1,
      },
      { startedAt: "2026-07-05T00:00:01.000Z", id: "root" },
    ),
  );
  writeFileSync(
    join(dayDir, "rollout-child.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 20,
        cached_input_tokens: 0,
        output_tokens: 2,
      },
      {
        startedAt: "2026-07-05T00:00:03.000Z",
        id: "child",
        parentThreadId: "root",
      },
    ),
  );
  writeFileSync(
    join(dayDir, "rollout-peer-root.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 1000,
        cached_input_tokens: 0,
        output_tokens: 100,
      },
      { startedAt: "2026-07-05T00:00:02.000Z", id: "peer-root" },
    ),
  );

  const result = svc.sessions.usageSync({
    sessionId: firstSessionId,
    codexSessionsDir,
  });
  expect(result).toMatchObject({ synced: 1, skipped: 0, missing: 0 });
  expect(getSession(firstSessionId).usage![0]).toMatchObject({
    input_tokens: 1030,
    output_tokens: 103,
  });
  expect((getSession(firstSessionId) as any).subagent_usage[0]).toMatchObject({
    source_id: "child",
    parent_source_id: "root",
    input_tokens: 20,
    output_tokens: 2,
  });

  rmSync(codexSessionsDir, { recursive: true, force: true });
});

test("sessions.usageSync stores Codex worktree usage on the primary PR session only", async () => {
  const issue = svc.issues.create("me/proj", { title: "primary codex usage" });
  const firstSessionId = "99999999-0000-0000-0000-0000000000cf";
  const secondSessionId = "99999999-0000-0000-0000-0000000000d0";
  svc.sessions.register({
    id: firstSessionId,
    agent: "lh-build",
    session: firstSessionId,
    runtime: "codex",
    kind: "dev",
  });
  svc.sessions.register({
    id: secondSessionId,
    agent: "reviewer",
    session: secondSessionId,
    runtime: "codex",
    kind: "review",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    firstSessionId,
  );
  svc.sessions.link("me/proj", {
    sessionId: secondSessionId,
    pr: opened.number,
  });
  const createdAt = "2026-07-05T00:00:00Z";
  D.db.run(`UPDATE agent_sessions SET created_at = ? WHERE id IN (?, ?)`, [
    createdAt,
    firstSessionId,
    secondSessionId,
  ]);

  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${opened.number}`);
  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-peers-"));
  const dayDir = join(codexSessionsDir, "2026", "07", "05");
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, "rollout-root.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 1,
      },
      { startedAt: "2026-07-05T00:00:01.000Z", id: "root" },
    ),
  );

  const result = svc.sessions.usageSync({ codexSessionsDir });
  const statuses = result.sessions.filter((x: any) =>
    [firstSessionId, secondSessionId].includes(x.session_id),
  );
  expect(statuses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        session_id: firstSessionId,
        status: "updated",
      }),
      expect.objectContaining({
        session_id: secondSessionId,
        status: "skipped",
      }),
    ]),
  );
  expect(getSession(firstSessionId).usage![0]).toMatchObject({
    input_tokens: 10,
    output_tokens: 1,
  });
  expect(getSession(secondSessionId).usage ?? []).toEqual([]);

  rmSync(codexSessionsDir, { recursive: true, force: true });
});

test("sessions.usageSync preserves Codex worktree usage when the PR primary session is non-Codex", async () => {
  const issue = svc.issues.create("me/proj", {
    title: "mixed runtime codex usage",
  });
  const devSessionId = "99999999-0000-0000-0000-0000000000d5";
  const codexSessionId = "99999999-0000-0000-0000-0000000000d6";
  svc.sessions.register({
    id: devSessionId,
    agent: "lh-build",
    session: devSessionId,
    runtime: "claude-code",
    kind: "dev",
  });
  svc.sessions.register({
    id: codexSessionId,
    agent: "reviewer",
    session: codexSessionId,
    runtime: "codex",
    kind: "review",
  });
  const opened = await svc.dev.openPr(
    "me/proj",
    { issue: issue.number, base: "main" },
    devSessionId,
  );
  svc.sessions.link("me/proj", {
    sessionId: codexSessionId,
    pr: opened.number,
  });

  const worktree = join(HOME, "worktrees", "me", "proj", `pr-${opened.number}`);
  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-mixed-"));
  const dayDir = join(codexSessionsDir, "2026", "07", "05");
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, "rollout-review.jsonl"),
    codexRollout(
      worktree,
      "gpt-5.5",
      {
        input_tokens: 50,
        cached_input_tokens: 10,
        output_tokens: 4,
      },
      {
        startedAt: "2026-07-05T00:00:01.000Z",
        id: "review-root",
        modelContextWindow: 100,
        lastTokenUsage: { total_tokens: 73 },
      },
    ),
  );

  const result = svc.sessions.usageSync({ codexSessionsDir });
  expect(result.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        session_id: codexSessionId,
        status: "updated",
      }),
    ]),
  );
  expect(getSession(devSessionId).usage ?? []).toEqual([]);
  expect(getSession(codexSessionId).usage![0]).toMatchObject({
    input_tokens: 40,
    cache_read_input_tokens: 10,
    output_tokens: 4,
    context_usage_percent: 73,
  });
  const pull = (await svc.pulls.get("me/proj", opened.number)) as any;
  expect(pull.related_sessions_usage).toMatchObject({
    sessions_with_usage: 1,
    input_tokens: 40,
    cache_read_input_tokens: 10,
    output_tokens: 4,
    total_tokens: 54,
    context_usage_percent: 73,
  });

  rmSync(codexSessionsDir, { recursive: true, force: true });
});

test("pull detail includes related session usage and an n/a aggregate for unknown costs", async () => {
  const issue = svc.issues.create("me/proj", { title: "usage on PR detail" });
  const devSessionId = "77777777-0000-0000-0000-000000000001";
  const reviewSessionId = "77777777-0000-0000-0000-000000000002";
  svc.sessions.register({
    id: devSessionId,
    agent: "lh-build",
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
  const devSubagentDir = join(projectDir, devSessionId, "subagents");
  mkdirSync(devSubagentDir, { recursive: true });
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
    join(devSubagentDir, "agent-security.jsonl"),
    [
      JSON.stringify({
        type: "user",
        isSidechain: true,
        agentId: "agent-security",
        sessionId: devSessionId,
        message: { content: "Role: Security reviewer\nReview only." },
      }),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        agentId: "agent-security",
        attributionAgent: "general-purpose",
        message: {
          id: "sub_msg",
          model: "claude-haiku-3-5-20241022",
          usage: {
            input_tokens: 7,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2,
            output_tokens: 3,
          },
        },
      }),
    ].join("\n"),
  );
  writeFileSync(
    join(projectDir, `${reviewSessionId}.jsonl`),
    [
      assistantLine("unknown_msg", "claude-sonnet-4-6-20260601", {
        input_tokens: 870_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      }),
      assistantLine("unknown_msg_2", "unknown-model", {
        input_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 2,
      }),
    ].join(""),
  );

  svc.sessions.usageSync({ sessionId: devSessionId, projectsDir });
  svc.sessions.usageSync({ sessionId: reviewSessionId, projectsDir });

  const pull = (await svc.pulls.get("me/proj", opened.number)) as any;
  const dev = pull.related_sessions.find((s: any) => s.id === devSessionId);
  const review = pull.related_sessions.find(
    (s: any) => s.id === reviewSessionId,
  );
  expect(dev.usage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "claude-sonnet-4-6-20260601",
        input_tokens: 100,
        output_tokens: 10,
      }),
    ]),
  );
  expect(review.usage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "claude-sonnet-4-6-20260601",
        input_tokens: 870_000,
        output_tokens: 5,
        context_usage_percent: 87,
      }),
      expect.objectContaining({
        model: "unknown-model",
        input_tokens: 2,
        output_tokens: 2,
        cost_usd: null,
        context_usage_percent: null,
      }),
    ]),
  );
  expect(pull.related_sessions_usage).toMatchObject({
    sessions_with_usage: 2,
    input_tokens: 870_109,
    cache_creation_input_tokens: 21,
    cache_read_input_tokens: 32,
    output_tokens: 20,
    total_tokens: 870_182,
    cost_usd: null,
    has_unknown_cost: true,
    context_usage_percent: 87,
  });
  expect(pull.related_sessions_usage.by_kind).toMatchObject([
    {
      kind: "dev",
      sessions_with_usage: 1,
      total_tokens: 173,
      has_unknown_cost: false,
      context_usage_percent: 0.015,
      subagents: [
        {
          session_id: devSessionId,
          source_id: "agent-security",
          label: "Security reviewer",
          kind: "claude-sidechain",
          sessions_with_usage: 1,
          input_tokens: 7,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 2,
          output_tokens: 3,
          total_tokens: 13,
          has_unknown_cost: false,
          context_usage_percent: 0.005,
        },
      ],
    },
    {
      kind: "review",
      sessions_with_usage: 1,
      total_tokens: 870_009,
      cost_usd: null,
      has_unknown_cost: true,
      context_usage_percent: 87,
    },
  ]);

  rmSync(projectsDir, { recursive: true, force: true });
});

test("default usageSync sweeps only open-PR-linked sessions; --session recomputes any", async () => {
  // #1119: the default sweep (no sessionId) should scan sessions linked to an *open* PR only —
  // closed/merged PRs, issue-only links, and unlinked sessions are skipped so their transcripts are
  // never walked. `--session <id>` still force-recomputes any session regardless.
  // Empty transcript dirs -> every scanned session resolves "missing"; also keeps the sweep off the
  // real ~/.claude and ~/.codex.
  const projectsDir = mkdtempSync(join(tmpdir(), "lh-sweep-scope-"));
  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-sweep-codex-"));
  const mk = (id: string) =>
    svc.sessions.register({
      id,
      agent: "lh-build",
      session: id,
      runtime: "claude-code",
      kind: "dev",
    });

  const openId = "f0f0f0f0-0000-0000-0000-000000000001";
  const closedId = "f0f0f0f0-0000-0000-0000-000000000002";
  const mergedId = "f0f0f0f0-0000-0000-0000-000000000003";
  const issueOnlyId = "f0f0f0f0-0000-0000-0000-000000000004";
  const unlinkedId = "f0f0f0f0-0000-0000-0000-000000000005";
  for (const id of [openId, closedId, mergedId, issueOnlyId, unlinkedId])
    mk(id);

  const openIssue = svc.issues.create("me/proj", { title: "sweep open" });
  await svc.dev.openPr(
    "me/proj",
    {
      issue: openIssue.number,
      head: `loophub/issue-${openIssue.number}`,
      base: "main",
    },
    openId,
  );

  const closedIssue = svc.issues.create("me/proj", { title: "sweep closed" });
  const closedPr = await svc.dev.openPr(
    "me/proj",
    {
      issue: closedIssue.number,
      head: `loophub/issue-${closedIssue.number}`,
      base: "main",
    },
    closedId,
  );
  D.db.run(
    `UPDATE issues SET state = 'closed' WHERE repo_id = 1 AND number = ?`,
    [closedPr.number],
  );

  const mergedIssue = svc.issues.create("me/proj", { title: "sweep merged" });
  const mergedPr = await svc.dev.openPr(
    "me/proj",
    {
      issue: mergedIssue.number,
      head: `loophub/issue-${mergedIssue.number}`,
      base: "main",
    },
    mergedId,
  );
  D.db.run(
    `UPDATE pulls SET merged = 1 WHERE issue_id = (SELECT id FROM issues WHERE repo_id = 1 AND number = ?)`,
    [mergedPr.number],
  );

  svc.sessions.link("me/proj", {
    sessionId: issueOnlyId,
    issue: openIssue.number,
  });

  const swept = svc.sessions.usageSync({ projectsDir, codexSessionsDir });
  const sweptIds = new Set(swept.sessions.map((s) => s.session_id));
  expect(sweptIds.has(openId)).toBe(true);
  expect(sweptIds.has(closedId)).toBe(false);
  expect(sweptIds.has(mergedId)).toBe(false);
  expect(sweptIds.has(issueOnlyId)).toBe(false);
  expect(sweptIds.has(unlinkedId)).toBe(false);

  // Manual --session bypasses the open-PR filter for an out-of-sweep session.
  const manual = svc.sessions.usageSync({
    sessionId: unlinkedId,
    projectsDir,
    codexSessionsDir,
  });
  expect(manual.sessions.map((s) => s.session_id)).toEqual([unlinkedId]);

  rmSync(projectsDir, { recursive: true, force: true });
  rmSync(codexSessionsDir, { recursive: true, force: true });
});

test("createClaudeTranscriptIndex direct-stats wanted transcripts without enumerating the project dir", () => {
  // #1119: with externalSessions provided, the index must not readdir the project subdirectory
  // (which can hold thousands of transcripts) — it stats only the requested filenames directly.
  const projectsDir = mkdtempSync(join(tmpdir(), "lh-idx-scope-"));
  const projectDir = join(projectsDir, "proj");
  mkdirSync(projectDir);
  const wantedId = "f0f0f0f0-1111-0000-0000-000000000001";
  writeFileSync(join(projectDir, `${wantedId}.jsonl`), "");
  for (let i = 0; i < 25; i++) {
    writeFileSync(join(projectDir, `decoy-${i}.jsonl`), "");
  }

  fsSpy.readdirDirs.length = 0;
  const index = SU.createClaudeTranscriptIndex(projectsDir, [wantedId]);
  // Only the wanted transcript is indexed, and the decoys were never enumerated.
  expect([...index.byFilename.keys()]).toEqual([`${wantedId}.jsonl`]);
  // With a wanted set, readdir touches only the top-level projects dir — never the project subdir.
  expect(fsSpy.readdirDirs).toContain(projectsDir);
  expect(fsSpy.readdirDirs).not.toContain(projectDir);

  // Without externalSessions the full enumeration lists the project subdir and indexes every file.
  fsSpy.readdirDirs.length = 0;
  const full = SU.createClaudeTranscriptIndex(projectsDir);
  expect(full.byFilename.size).toBe(26);
  expect(fsSpy.readdirDirs).toContain(projectDir);

  rmSync(projectsDir, { recursive: true, force: true });
});
