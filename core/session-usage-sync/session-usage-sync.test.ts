import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";
// Type-only: erased at compile time, so it cannot import core/db.ts before the env vars above.
import type { SessionUsageSyncCohort } from "./index.ts";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;

// Isolate the DB before any core module runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-usage-sync-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let D: typeof import("../db.ts");
let S: typeof import("../store.ts");
let sync: typeof import("./index.ts");

beforeAll(async () => {
  D = await import("../db.ts");
  S = await import("../store.ts");
  sync = await import("./index.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

let nextSessionOrdinal = 0;

function registerSession(
  runtime: string,
  opts: { kind?: string; createdAt?: string } = {},
) {
  nextSessionOrdinal += 1;
  const id = `${runtime}-session-${nextSessionOrdinal}`;
  S.registerAgentSession(
    id,
    "lh-build",
    id,
    null,
    runtime,
    opts.kind ?? "dev",
    null,
    opts.createdAt ?? null,
  );
  return S.getAgentSession(id)!;
}

function createRepoWithPath(fullName: string) {
  const localPath = mkdtempSync(join(tmpdir(), "lh-usage-sync-repo-"));
  return S.createRepo(fullName, localPath);
}

function createPullFor(repo: { id: number }, primarySessionId: string) {
  const issue = S.createIssue(repo.id, "issue", "feature", "", "me");
  const pr = S.createIssue(repo.id, "pull", "feature", "", "me");
  S.createPull(
    pr.id,
    `loophub/pr-${pr.number}`,
    "main",
    null,
    issue.id,
    primarySessionId,
  );
  return pr;
}

function worktreeCwd(repoFullName: string, prNumber: number) {
  return join(HOME, "worktrees", ...repoFullName.split("/"), `pr-${prNumber}`);
}

function writeCodexRollout(
  dir: string,
  name: string,
  cwd: string,
  usage: Record<string, number>,
  opts: { id?: string; parentThreadId?: string } = {},
) {
  const payload: Record<string, unknown> = {
    cwd,
    model: "gpt-5.5",
    timestamp: new Date().toISOString(),
  };
  if (opts.id) payload.id = opts.id;
  if (opts.parentThreadId) payload.parent_thread_id = opts.parentThreadId;
  writeFileSync(
    join(dir, name),
    [
      JSON.stringify({ type: "session_meta", payload }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: usage },
        },
      }),
    ].join("\n"),
  );
}

function writeClaudeTranscript(projectsDir: string, sessionId: string) {
  const projectDir = join(projectsDir, "repo-worktree");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      message: {
        id: `${sessionId}-msg-1`,
        model: "claude-sonnet-4-6-20260601",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 10,
        },
      },
    })}\n`,
  );
}

const USAGE_TABLES = [
  "session_usage",
  "session_usage_subagents",
  "session_usage_cursors",
  "session_usage_messages",
  "events",
] as const;

function usageTableSnapshot() {
  return Object.fromEntries(
    USAGE_TABLES.map((table) => [
      table,
      D.db.query(`SELECT * FROM ${table}`).all(),
    ]),
  );
}

function planFor(cohorts: SessionUsageSyncCohort[], sessionId: string) {
  return cohorts
    .flatMap((cohort) => cohort.plans)
    .find((plan) => plan.sessionId === sessionId)!;
}

test("planning routes each session to its runtime module without touching the DB", () => {
  const repo = createRepoWithPath("me/plan-readonly");
  const codexSession = registerSession("codex");
  const pr = createPullFor(repo, codexSession.id);
  S.linkSession(codexSession.id, pr.id);
  const cwd = worktreeCwd(repo.full_name, pr.number);

  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-"));
  writeCodexRollout(codexSessionsDir, "rollout-root.jsonl", cwd, {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 5,
  });

  const claudeSession = registerSession("claude-code");
  const projectsDir = mkdtempSync(join(tmpdir(), "lh-claude-"));
  writeClaudeTranscript(projectsDir, claudeSession.id);

  const rows = [codexSession, claudeSession];
  const before = usageTableSnapshot();
  const cohorts = sync.planSessionUsageSync(rows, {
    codexSessionsDir,
    projectsDir,
  });
  expect(usageTableSnapshot()).toEqual(before);

  expect(
    cohorts.flatMap((cohort) => cohort.plans).map((plan) => plan.sessionId),
  ).toHaveLength(rows.length);
  expect(planFor(cohorts, codexSession.id).usage).toMatchObject([
    { model: "gpt-5.5", input_tokens: 80, cache_read_input_tokens: 20 },
  ]);
  expect(planFor(cohorts, claudeSession.id).messageIds).toEqual([
    `${claudeSession.id}-msg-1`,
  ]);

  // The plans still describe unapplied work; only the executor writes.
  const applied = sync.applySessionUsageSync(cohorts);
  expect(applied.get(codexSession.id)?.status).toBe("updated");
  expect(S.listSessionUsage(codexSession.id)).toHaveLength(1);

  rmSync(codexSessionsDir, { recursive: true, force: true });
  rmSync(projectsDir, { recursive: true, force: true });
});

test("the Codex module plans one worktree aggregate and supersedes its peers", () => {
  const repo = createRepoWithPath("me/codex-owner");
  const owner = registerSession("codex");
  // Only the owner is the PR's dev session, so it holds the worktree aggregate.
  const peer = registerSession("codex", { kind: "workflow-step" });
  const pr = createPullFor(repo, owner.id);
  S.linkSession(owner.id, pr.id);
  S.linkSession(peer.id, pr.id);
  S.upsertSessionUsage(peer.id, {
    model: "gpt-5.5",
    input_tokens: 7,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1,
    cost_usd: null,
  });

  const codexSessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-owner-"));
  const cwd = worktreeCwd(repo.full_name, pr.number);
  writeCodexRollout(
    codexSessionsDir,
    "rollout-root.jsonl",
    cwd,
    { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 },
    { id: "root-thread" },
  );
  writeCodexRollout(
    codexSessionsDir,
    "rollout-child.jsonl",
    cwd,
    { input_tokens: 30, cached_input_tokens: 0, output_tokens: 2 },
    { id: "child-thread", parentThreadId: "root-thread" },
  );

  const cohorts = sync.planSessionUsageSync([owner, peer], {
    codexSessionsDir,
  });
  const ownerPlan = planFor(cohorts, owner.id);
  expect(ownerPlan.clearUsageFor).toEqual([peer.id]);
  expect(ownerPlan.usage).toMatchObject([{ input_tokens: 130 }]);
  expect(ownerPlan.subagents?.rows).toMatchObject([
    { source_id: "child-thread", parent_source_id: "root-thread" },
  ]);
  expect(planFor(cohorts, peer.id)).toMatchObject({
    resetUsage: true,
    report: { status: "skipped" },
  });

  sync.applySessionUsageSync(cohorts);
  expect(S.listSessionUsage(owner.id)).toMatchObject([{ input_tokens: 130 }]);
  expect(S.listSessionUsage(peer.id)).toEqual([]);

  rmSync(codexSessionsDir, { recursive: true, force: true });
});

test("the executor rolls back every plan in a cohort when one of them fails", () => {
  const written = registerSession("claude-code");
  const conflicting = registerSession("claude-code");
  S.insertSessionUsageMessage(conflicting.id, "already-imported");

  expect(() =>
    sync.applySessionUsageSync([
      {
        key: "rollback",
        plans: [
          {
            sessionId: written.id,
            usage: [
              {
                model: "claude-sonnet-4-6-20260601",
                input_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 10,
                cost_usd: 1,
              },
            ],
            report: { status: "updated", messages: 1, models: "stored" },
          },
          {
            sessionId: conflicting.id,
            messageIds: ["already-imported"],
            report: { status: "updated", messages: 1, models: "stored" },
          },
        ],
      },
    ]),
  ).toThrow("Session usage changed during sync");

  expect(S.listSessionUsage(written.id)).toEqual([]);
});

test("the OpenCode module aggregates worktree sessions and leaves unknown models unpriced", () => {
  const repo = createRepoWithPath("me/opencode-usage");
  const owner = registerSession("opencode");
  const peer = registerSession("opencode", { kind: "workflow-step" });
  const pr = createPullFor(repo, owner.id);
  S.linkSession(owner.id, pr.id);
  S.linkSession(peer.id, pr.id);
  S.upsertSessionUsage(peer.id, {
    model: "stale",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1,
    cost_usd: null,
  });

  const cwd = worktreeCwd(repo.full_name, pr.number);
  mkdirSync(cwd, { recursive: true });
  const dbPath = join(
    mkdtempSync(join(tmpdir(), "lh-opencode-sync-")),
    "opencode.db",
  );
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      model TEXT,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO session (
      id, parent_id, directory, model,
      tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, time_created, time_updated
    ) VALUES (?, NULL, ?, ?, 0, 0, 0, 0, 0, 1, 2)`,
  ).run(
    "ses_root",
    cwd,
    JSON.stringify({ id: "claude-sonnet-4-6", providerID: "anthropic" }),
  );
  db.prepare(
    `INSERT INTO session (
      id, parent_id, directory, model,
      tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, time_created, time_updated
    ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 3, 4)`,
  ).run(
    "ses_child",
    "ses_root",
    cwd,
    JSON.stringify({ id: "big-pickle", providerID: "opencode" }),
  );
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, 5, 5, ?)`,
  ).run(
    "msg_root",
    "ses_root",
    JSON.stringify({
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
      tokens: {
        input: 100,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  );
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, 6, 6, ?)`,
  ).run(
    "msg_child",
    "ses_child",
    JSON.stringify({
      role: "assistant",
      providerID: "opencode",
      modelID: "big-pickle",
      tokens: {
        input: 50,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  );
  db.close();

  const cohorts = sync.planSessionUsageSync([owner, peer], {
    opencodeDbPath: dbPath,
  });
  const ownerPlan = planFor(cohorts, owner.id);
  expect(ownerPlan.clearUsageFor).toEqual([peer.id]);
  expect(ownerPlan.usage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-6",
        input_tokens: 100,
        cost_usd: expect.any(Number),
      }),
      expect.objectContaining({
        model: "opencode/big-pickle",
        input_tokens: 50,
        cost_usd: null,
      }),
    ]),
  );
  expect(ownerPlan.subagents?.rows).toMatchObject([
    {
      source_id: "ses_child",
      parent_source_id: "ses_root",
      model: "opencode/big-pickle",
      cost_usd: null,
    },
  ]);
  expect(planFor(cohorts, peer.id)).toMatchObject({
    resetUsage: true,
    report: { status: "skipped" },
  });

  sync.applySessionUsageSync(cohorts);
  const stored = S.listSessionUsage(owner.id);
  expect(stored).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-6",
        input_tokens: 100,
      }),
      expect.objectContaining({
        model: "opencode/big-pickle",
        input_tokens: 50,
        cost_usd: null,
      }),
    ]),
  );
  expect(
    stored.find((row) => row.model === "anthropic/claude-sonnet-4-6")?.cost_usd,
  ).not.toBeNull();
  expect(S.listSessionUsage(peer.id)).toEqual([]);
  expect(S.listSessionSubagentUsage(owner.id)).toMatchObject([
    { source_id: "ses_child", kind: "opencode-child-session" },
  ]);

  rmSync(dbPath, { force: true });
});

test("the executor refuses a plan whose expected usage moved on", () => {
  const session = registerSession("codex");
  S.upsertSessionUsage(session.id, {
    model: "gpt-5.5",
    input_tokens: 42,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1,
    cost_usd: null,
  });

  expect(() =>
    sync.applySessionUsageSync([
      {
        key: "stale-usage",
        plans: [
          {
            sessionId: session.id,
            expect: { usage: [] },
            resetUsage: true,
            report: { status: "updated", messages: 0, models: "stored" },
          },
        ],
      },
    ]),
  ).toThrow("Session usage changed during sync");

  expect(S.listSessionUsage(session.id)).toMatchObject([{ input_tokens: 42 }]);
});

test("the executor refuses a plan whose expected transcript cursor moved on", () => {
  const session = registerSession("claude-code");
  S.upsertSessionUsageCursor({
    sessionId: session.id,
    transcriptPath: "/transcripts/a.jsonl",
    cursorOffset: 10,
    mtimeMs: 1,
  });
  const stored = S.getSessionUsageCursor(session.id)!;

  expect(() =>
    sync.applySessionUsageSync([
      {
        key: "stale-cursor",
        plans: [
          {
            sessionId: session.id,
            expect: { cursor: { ...stored, cursor_offset: 5 } },
            cursor: {
              transcriptPath: "/transcripts/a.jsonl",
              cursorOffset: 20,
              mtimeMs: 2,
            },
            report: { status: "updated", messages: 0, models: "stored" },
          },
        ],
      },
    ]),
  ).toThrow("Session usage changed during sync");

  expect(S.getSessionUsageCursor(session.id)).toMatchObject({
    cursor_offset: 10,
  });
});
