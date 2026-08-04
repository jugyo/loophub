import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  aggregateUsage,
  calculateCostUsd,
  claudeContextWindowForModel,
  encodeCursorProjectCwd,
  findCodexRollouts,
  findCursorTranscripts,
  parseClaudeSubagentJsonl,
  parseClaudeUsageJsonl,
  parseCodexRolloutJsonl,
  parseCursorHeadlessResult,
  parseGrokTurnUsages,
  parseGrokUpdatesJsonl,
  priceForModel,
} from "./session-usage.ts";
import {
  calculateTokenRates,
  calculateTokensPerSecond,
  newGrokWorkDurationMs,
  planGrokTurnRateSamples,
} from "./session-usage-rate.ts";

test("parseCursorHeadlessResult reads the structured chat identifier", () => {
  expect(
    parseCursorHeadlessResult(
      JSON.stringify({
        type: "result",
        session_id: "cursor-chat-id",
        result: "Created issue",
      }),
    ),
  ).toEqual({ sessionId: "cursor-chat-id", result: "Created issue" });
  expect(parseCursorHeadlessResult("not json")).toBeNull();
});

test("findCursorTranscripts locates chat transcripts by encoded cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "lh-cursor-projects-"));
  const projectsDir = join(root, "projects");
  const cwd = join(root, "repo-worktree");
  mkdirSync(cwd);
  const transcriptDir = join(
    projectsDir,
    encodeCursorProjectCwd(realpathSync(cwd)),
    "agent-transcripts",
    "chat-1",
  );
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, "chat-1.jsonl"),
    JSON.stringify({ role: "assistant", message: { content: [] } }),
  );
  expect(findCursorTranscripts({ cwd, projectsDir })).toMatchObject([
    { sessionId: "chat-1" },
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("findCursorTranscripts canonicalizes a symlinked cwd like Cursor trust", () => {
  const root = mkdtempSync(join(tmpdir(), "lh-cursor-symlink-"));
  const workspace = join(root, "workspace");
  const symlink = join(root, "worktree-link");
  const projectsDir = join(root, "projects");
  mkdirSync(workspace);
  symlinkSync(workspace, symlink, "dir");
  const transcriptDir = join(
    projectsDir,
    encodeCursorProjectCwd(realpathSync(symlink)),
    "agent-transcripts",
    "chat-via-symlink",
  );
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, "chat-via-symlink.jsonl"),
    JSON.stringify({ role: "assistant", message: { content: [] } }),
  );

  expect(findCursorTranscripts({ cwd: symlink, projectsDir })).toMatchObject([
    { sessionId: "chat-via-symlink" },
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("encodeCursorProjectCwd matches Cursor for dot-prefixed path components", () => {
  expect(
    encodeCursorProjectCwd(
      "/Users/example/.loophub/worktrees/acme/widgets/pr-42",
    ),
  ).toBe("Users-example-loophub-worktrees-acme-widgets-pr-42");
});

test("parseClaudeUsageJsonl extracts assistant usage and dedupes message ids", () => {
  const text = [
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6-20260601",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 10,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6-20260601",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 10,
        },
      },
    }),
    JSON.stringify({ type: "user", message: { id: "u" } }),
  ].join("\n");

  const entries = parseClaudeUsageJsonl(text);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    message_id: "msg_1",
    model: "claude-sonnet-4-6-20260601",
    input_tokens: 100,
  });
});

test("calculateTokensPerSecond uses recent token deltas over elapsed seconds", () => {
  const now = new Date("2026-07-10T00:01:00Z");
  expect(
    calculateTokensPerSecond(
      [
        {
          session_id: "s1",
          total_tokens: 100,
          token_delta: 0,
          observed_at: "2026-07-10T00:00:30Z",
        },
        {
          session_id: "s1",
          total_tokens: 250,
          token_delta: 150,
          observed_at: "2026-07-10T00:01:00Z",
        },
      ],
      { now },
    ),
  ).toBe(5);
});

test("calculateTokenRates separates cache reads from regular throughput", () => {
  const now = new Date("2026-07-10T00:01:00Z");
  expect(
    calculateTokenRates(
      [
        {
          session_id: "s1",
          total_tokens: 100,
          token_delta: 0,
          cache_read_tokens: 60,
          cache_read_delta: 0,
          observed_at: "2026-07-10T00:00:30Z",
        },
        {
          session_id: "s1",
          total_tokens: 550,
          token_delta: 150,
          cache_read_tokens: 360,
          cache_read_delta: 300,
          observed_at: "2026-07-10T00:01:00Z",
        },
      ],
      { now },
    ),
  ).toEqual({
    tokensPerSecond: 5,
    cacheReadTokensPerSecond: 10,
  });
});

test("calculateTokensPerSecond returns null with insufficient samples", () => {
  expect(
    calculateTokensPerSecond(
      [
        {
          session_id: "s1",
          total_tokens: 100,
          token_delta: 0,
          observed_at: "2026-07-10T00:01:00Z",
        },
      ],
      { now: new Date("2026-07-10T00:01:00Z") },
    ),
  ).toBeNull();
});

test("calculateTokensPerSecond returns zero for measured zero throughput", () => {
  expect(
    calculateTokensPerSecond(
      [
        {
          session_id: "s1",
          total_tokens: 100,
          token_delta: 0,
          observed_at: "2026-07-10T00:00:30Z",
        },
        {
          session_id: "s1",
          total_tokens: 100,
          token_delta: 0,
          observed_at: "2026-07-10T00:01:00Z",
        },
      ],
      { now: new Date("2026-07-10T00:01:00Z") },
    ),
  ).toBe(0);
});

test("calculateTokensPerSecond ignores resets and decreasing cumulative totals", () => {
  expect(
    calculateTokensPerSecond(
      [
        {
          session_id: "s1",
          total_tokens: 500,
          token_delta: 0,
          observed_at: "2026-07-10T00:00:30Z",
        },
        {
          session_id: "s1",
          total_tokens: 10,
          token_delta: 0,
          observed_at: "2026-07-10T00:01:00Z",
        },
        {
          session_id: "s1",
          total_tokens: 70,
          token_delta: 60,
          observed_at: "2026-07-10T00:01:30Z",
        },
      ],
      { now: new Date("2026-07-10T00:01:30Z"), windowSeconds: 90 },
    ),
  ).toBe(1);
});

test("calculateTokensPerSecond ignores stale samples", () => {
  expect(
    calculateTokensPerSecond(
      [
        {
          session_id: "s1",
          total_tokens: 100,
          token_delta: 0,
          observed_at: "2026-07-10T00:00:00Z",
        },
        {
          session_id: "s1",
          total_tokens: 200,
          token_delta: 100,
          observed_at: "2026-07-10T00:00:30Z",
        },
      ],
      {
        now: new Date("2026-07-10T00:02:30Z"),
        maxSampleAgeSeconds: 60,
      },
    ),
  ).toBeNull();
});

test("calculateTokensPerSecond combines multiple sessions", () => {
  const now = new Date("2026-07-10T00:01:00Z");
  expect(
    calculateTokensPerSecond(
      [
        {
          session_id: "s1",
          total_tokens: 100,
          token_delta: 0,
          observed_at: "2026-07-10T00:00:30Z",
        },
        {
          session_id: "s1",
          total_tokens: 250,
          token_delta: 150,
          observed_at: "2026-07-10T00:01:00Z",
        },
        {
          session_id: "s2",
          total_tokens: 10,
          token_delta: 0,
          observed_at: "2026-07-10T00:00:30Z",
        },
        {
          session_id: "s2",
          total_tokens: 100,
          token_delta: 90,
          observed_at: "2026-07-10T00:01:00Z",
        },
      ],
      { now },
    ),
  ).toBe(8);
});

test("parseClaudeUsageJsonl derives context usage from message usage buckets", () => {
  const text = [
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6-20260601",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 10,
        },
      },
    }),
  ].join("\n");

  expect(parseClaudeUsageJsonl(text)[0]).toMatchObject({
    context_usage_percent: 0.042,
  });
});

test("parseClaudeUsageJsonl derives context usage for older Claude 4 windows", () => {
  const text = [
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 10,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_2",
        model: "claude-opus-4-1-20250805",
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 600,
          output_tokens: 20,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_3",
        model: "claude-opus-4-20250514",
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 600,
          output_tokens: 20,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_4",
        model: "claude-opus-4-10-20261201",
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 600,
          output_tokens: 20,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_5",
        model: "claude-3-7-sonnet-20250219",
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 600,
          output_tokens: 20,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_6",
        model: "claude-haiku-3-5-20241022",
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 600,
          output_tokens: 20,
        },
      },
    }),
  ].join("\n");

  const entries = parseClaudeUsageJsonl(text);
  expect(entries[0]).toMatchObject({
    context_usage_percent: 0.21,
  });
  expect(entries[1]).toMatchObject({
    context_usage_percent: 0.42,
  });
  expect(entries[2]).toMatchObject({
    context_usage_percent: 0.42,
  });
  expect(entries[3]).toMatchObject({
    context_usage_percent: 0.084,
  });
  expect(entries[4]).toMatchObject({
    context_usage_percent: 0.42,
  });
  expect(entries[5]).toMatchObject({
    context_usage_percent: 0.42,
  });
});

test("claudeContextWindowForModel returns the 1M window for claude-opus-5", () => {
  expect(claudeContextWindowForModel("claude-opus-5")).toBe(1_000_000);
});

test("parseClaudeUsageJsonl leaves context usage unavailable for unknown model windows", () => {
  const text = [
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "unknown-model",
        context_management: { applied_edits: [] },
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 10,
        },
      },
    }),
  ].join("\n");

  expect(parseClaudeUsageJsonl(text)[0]).toMatchObject({
    context_usage_percent: null,
  });
});

test("parseClaudeUsageJsonl leaves context usage unavailable without input buckets", () => {
  const text = [
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6-20260601",
        usage: {
          output_tokens: 10,
        },
      },
    }),
  ].join("\n");

  expect(parseClaudeUsageJsonl(text)[0]).toMatchObject({
    context_usage_percent: null,
  });
});

test("parseClaudeSubagentJsonl extracts sidechain metadata and usage", () => {
  const text = [
    JSON.stringify({
      type: "user",
      isSidechain: true,
      agentId: "agent-1",
      sessionId: "parent-session",
      message: { content: "Role: Security reviewer\nCheck the diff." },
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      agentId: "agent-1",
      attributionAgent: "general-purpose",
      message: {
        id: "msg_1",
        model: "claude-haiku-3-5-20241022",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 4,
        },
      },
    }),
  ].join("\n");

  const parsed = parseClaudeSubagentJsonl(text, "fallback");
  expect(parsed).toMatchObject({
    sourceId: "agent-1",
    parentSourceId: "parent-session",
    label: "Security reviewer",
    kind: "claude-sidechain",
  });
  expect(parsed.entries[0]).toMatchObject({
    message_id: "msg_1",
    model: "claude-haiku-3-5-20241022",
    input_tokens: 10,
    output_tokens: 4,
  });
});

test("parseClaudeSubagentJsonl does not persist arbitrary prompt role text", () => {
  const text = [
    JSON.stringify({
      type: "user",
      isSidechain: true,
      agentId: "agent-1",
      sessionId: "parent-session",
      message: { content: "Role: customer password hunter\nSecret task." },
    }),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      agentId: "agent-1",
      attributionAgent: "general-purpose",
      message: {
        id: "msg_1",
        model: "claude-haiku-3-5-20241022",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
        },
      },
    }),
  ].join("\n");

  expect(parseClaudeSubagentJsonl(text, "fallback").label).toBe(
    "general-purpose",
  );
});

test("aggregateUsage computes known model cost and leaves unknown models null", () => {
  const [sonnet, unknown] = aggregateUsage([
    {
      message_id: "msg_1",
      model: "claude-sonnet-4-6-20260601",
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 300,
      output_tokens: 10,
      context_usage_percent: 42,
    },
    {
      message_id: "msg_1b",
      model: "claude-sonnet-4-6-20260601",
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
      context_usage_percent: 55,
    },
    {
      message_id: "msg_2",
      model: "future-model",
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
    },
  ]);

  expect(sonnet.cost_usd).toBeCloseTo(0.000633);
  expect(sonnet.context_usage_percent).toBe(55);
  expect(unknown.cost_usd).toBeNull();
  expect(unknown.context_usage_percent).toBeNull();
  expect(calculateCostUsd("future-model", sonnet)).toBeNull();
});

test("aggregateUsage drops all-zero model totals", () => {
  const usage = aggregateUsage([
    {
      message_id: "synthetic",
      model: "<synthetic>",
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
    {
      message_id: "codex",
      model: "codex",
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
    {
      message_id: "real",
      model: "gpt-5.5",
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5,
      output_tokens: 2,
    },
  ]);

  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    model: "gpt-5.5",
    input_tokens: 10,
    cache_read_input_tokens: 5,
    output_tokens: 2,
  });
});

test("parseCodexRolloutJsonl extracts final cumulative token count", () => {
  const text = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/tmp/worktree",
        model: "gpt-5.5",
        timestamp: "2026-07-05T00:00:00.000Z",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 200,
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 5,
          },
          last_token_usage: {
            total_tokens: 80,
          },
        },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 200,
          total_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 50,
            output_tokens: 12,
            reasoning_output_tokens: 6,
          },
          last_token_usage: {
            total_tokens: 90,
          },
        },
      },
    }),
  ].join("\n");

  const parsed = parseCodexRolloutJsonl(text, "rollout");
  expect(parsed.cwd).toBe("/tmp/worktree");
  expect(parsed.startedAtMs).toBe(Date.parse("2026-07-05T00:00:00.000Z"));
  expect(parsed.entries).toHaveLength(1);
  expect(parsed.entries[0]).toMatchObject({
    message_id: "rollout",
    model: "gpt-5.5",
    input_tokens: 70,
    cache_read_input_tokens: 50,
    output_tokens: 12,
    context_usage_percent: 45,
  });
  expect(calculateCostUsd("gpt-5.5", parsed.entries[0])).toBeCloseTo(0.000735);
});

test("parseCodexRolloutJsonl prices leading token counts emitted before the model context", () => {
  const tokenCount = (
    inputTokens: number,
    cachedTokens: number,
    outputTokens: number,
  ) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cachedTokens,
            output_tokens: outputTokens,
          },
        },
      },
    });
  const text = [
    JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/tmp/worktree", model: null },
    }),
    tokenCount(100, 40, 10),
    JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    tokenCount(150, 60, 15),
  ].join("\n");

  const parsed = parseCodexRolloutJsonl(text, "late-model-rollout");
  expect(parsed.entries).toEqual([
    expect.objectContaining({
      model: "gpt-5.6-sol",
      input_tokens: 90,
      cache_read_input_tokens: 60,
      output_tokens: 15,
    }),
  ]);
  expect(aggregateUsage(parsed.entries)[0].cost_usd).toBeCloseTo(0.00093);
});

test("parseCodexRolloutJsonl keeps usage unknown when no model context arrives", () => {
  const parsed = parseCodexRolloutJsonl(
    [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/tmp/worktree", model: null },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 10,
            },
          },
        },
      }),
    ].join("\n"),
  );

  expect(parsed.entries[0].model).toBe("codex");
  expect(aggregateUsage(parsed.entries)[0].cost_usd).toBeNull();
});

test("findCodexRollouts removes inherited counters when children copy parent metadata", () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), "lh-codex-forks-"));
  const dayDir = join(sessionsDir, "2026", "07", "19");
  const cwd = "/tmp/worktree";
  mkdirSync(dayDir, { recursive: true });

  const count = (
    inputTokens: number,
    cachedInputTokens: number,
    outputTokens: number,
  ) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cachedInputTokens,
            output_tokens: outputTokens,
          },
        },
      },
    });
  const rollout = (
    id: string,
    parentThreadId: string | null,
    totals: Array<[number, number, number]>,
  ) =>
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id,
          ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
          cwd,
          model: "gpt-5.5",
          timestamp: "2026-07-19T15:00:00.000Z",
        },
      }),
      ...(parentThreadId
        ? [
            JSON.stringify({
              type: "session_meta",
              payload: {
                id: parentThreadId,
                cwd,
                model: "gpt-5.5",
                timestamp: "2026-07-19T15:00:00.000Z",
              },
            }),
          ]
        : []),
      ...totals.map(([input, cached, output]) => count(input, cached, output)),
    ].join("\n");
  const inherited: Array<[number, number, number]> = [
    [100, 40, 10],
    [140, 50, 14],
  ];

  try {
    writeFileSync(
      join(dayDir, "rollout-parent.jsonl"),
      rollout("parent", null, inherited),
    );
    writeFileSync(
      join(dayDir, "rollout-child-a.jsonl"),
      rollout("child-a", "parent", [...inherited, [170, 60, 17]]),
    );
    writeFileSync(
      join(dayDir, "rollout-child-b.jsonl"),
      rollout("child-b", "parent", [...inherited, [160, 55, 16]]),
    );

    const rollouts = findCodexRollouts({ cwd, sessionsDir });
    const usage = aggregateUsage(rollouts.flatMap((row) => row.entries));

    expect(rollouts).toHaveLength(3);
    expect(
      rollouts.find((row) => row.threadId === "child-a")?.entries[0],
    ).toMatchObject({
      input_tokens: 20,
      cache_read_input_tokens: 10,
      output_tokens: 3,
    });
    expect(
      rollouts.find((row) => row.threadId === "child-b")?.entries[0],
    ).toMatchObject({
      input_tokens: 15,
      cache_read_input_tokens: 5,
      output_tokens: 2,
    });
    expect(usage).toMatchObject([
      {
        model: "gpt-5.5",
        input_tokens: 125,
        cache_read_input_tokens: 65,
        output_tokens: 19,
      },
    ]);
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("parseCodexRolloutJsonl preserves zero context usage as 0%", () => {
  const text = [
    JSON.stringify({
      type: "session_meta",
      payload: { model: "gpt-5.5" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 200,
          total_token_usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
          },
          last_token_usage: {
            total_tokens: 0,
          },
        },
      },
    }),
  ].join("\n");

  const parsed = parseCodexRolloutJsonl(text, "rollout");
  expect(parsed.entries[0]).toMatchObject({
    context_usage_percent: 0,
  });
});

test("parseCodexRolloutJsonl ignores codex-auto-review usage", () => {
  const text = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/tmp/worktree",
        model: "gpt-5.5",
        timestamp: "2026-07-05T00:00:00.000Z",
        id: "auto-review-thread",
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        model: "codex-auto-review",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 200,
          total_token_usage: {
            input_tokens: 177000,
            cache_read_input_tokens: 493000,
            output_tokens: 4000,
          },
          last_token_usage: {
            total_tokens: 674000,
          },
        },
      },
    }),
  ].join("\n");

  const parsed = parseCodexRolloutJsonl(text, "rollout-auto-review");
  expect(parsed.cwd).toBe("/tmp/worktree");
  expect(parsed.threadId).toBe("auto-review-thread");
  expect(parsed.entries).toEqual([]);
  expect(aggregateUsage(parsed.entries)).toEqual([]);
  expect(priceForModel("codex-auto-review")).toBeNull();
});

test("parseCodexRolloutJsonl keeps normal usage before codex-auto-review turns", () => {
  const text = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/tmp/worktree",
        model: "gpt-5.5",
        timestamp: "2026-07-05T00:00:00.000Z",
        id: "mixed-thread",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 1_000,
          total_token_usage: {
            input_tokens: 200,
            cache_read_input_tokens: 50,
            output_tokens: 20,
          },
          last_token_usage: {
            total_tokens: 270,
          },
        },
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        model: "codex-auto-review",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 1_000,
          total_token_usage: {
            input_tokens: 500,
            cache_read_input_tokens: 200,
            output_tokens: 40,
          },
          last_token_usage: {
            total_tokens: 740,
          },
        },
      },
    }),
  ].join("\n");

  const parsed = parseCodexRolloutJsonl(text, "rollout-mixed");
  expect(parsed.entries).toHaveLength(1);
  expect(parsed.entries[0]).toMatchObject({
    message_id: "rollout-mixed",
    model: "gpt-5.5",
    input_tokens: 150,
    cache_read_input_tokens: 50,
    output_tokens: 20,
    context_usage_percent: 27,
  });
});

test("parseCodexRolloutJsonl subtracts ignored cumulative usage before later normal turns", () => {
  const text = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/tmp/worktree",
        model: "gpt-5.5",
        timestamp: "2026-07-05T00:00:00.000Z",
        id: "mixed-thread",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 200,
            cache_read_input_tokens: 50,
            output_tokens: 20,
          },
        },
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        model: "codex-auto-review",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 500,
            cache_read_input_tokens: 200,
            output_tokens: 40,
          },
        },
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        model: "gpt-5.5",
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 550,
            cache_read_input_tokens: 210,
            output_tokens: 45,
          },
        },
      },
    }),
  ].join("\n");

  const parsed = parseCodexRolloutJsonl(text, "rollout-mixed");
  expect(parsed.entries).toHaveLength(1);
  expect(parsed.entries[0]).toMatchObject({
    model: "gpt-5.5",
    input_tokens: 190,
    cache_read_input_tokens: 60,
    output_tokens: 25,
  });
});

test("parseGrokUpdatesJsonl sums turn_completed modelUsage and maps cache/reasoning fields", () => {
  const text = [
    JSON.stringify({
      method: "_x.ai/session/update",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          usage: {
            inputTokens: 1000,
            outputTokens: 40,
            cachedReadTokens: 200,
            reasoningTokens: 10,
            apiDurationMs: 5000,
            modelUsage: {
              "grok-4.5": {
                inputTokens: 1000,
                outputTokens: 40,
                cachedReadTokens: 200,
                reasoningTokens: 10,
              },
            },
          },
        },
      },
    }),
    // Later turn_completed for the same prompt_id wins (not double-counted).
    JSON.stringify({
      method: "_x.ai/session/update",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          usage: {
            inputTokens: 1200,
            outputTokens: 50,
            cachedReadTokens: 300,
            reasoningTokens: 15,
            apiDurationMs: 12000,
            modelUsage: {
              "grok-4.5": {
                inputTokens: 1200,
                outputTokens: 50,
                cachedReadTokens: 300,
                reasoningTokens: 15,
              },
            },
          },
        },
      },
    }),
    JSON.stringify({
      method: "_x.ai/session/update",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p2",
          usage: {
            inputTokens: 100,
            outputTokens: 5,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            apiDurationMs: 2000,
            modelUsage: {
              "grok-code-fast-1": {
                inputTokens: 100,
                outputTokens: 5,
                cachedReadTokens: 0,
                reasoningTokens: 0,
              },
            },
          },
        },
      },
    }),
    // Non-usage rows are ignored.
    JSON.stringify({
      method: "_x.ai/session/update",
      params: { update: { sessionUpdate: "agent_message_chunk" } },
    }),
  ].join("\n");

  const entries = parseGrokUpdatesJsonl(text);
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "grok-4.5",
        // non-cached input = 1200 - 300
        input_tokens: 900,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 300,
        // reasoning folded into output
        output_tokens: 65,
      }),
      expect.objectContaining({
        model: "grok-code-fast-1",
        input_tokens: 100,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      }),
    ]),
  );
  expect(entries).toHaveLength(2);

  const turns = parseGrokTurnUsages(text);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({
    promptId: "p1",
    // latest p1 wins
    totalTokens: 900 + 300 + 65,
    apiDurationMs: 12000,
  });
  expect(turns[1]).toMatchObject({
    promptId: "p2",
    totalTokens: 105,
    apiDurationMs: 2000,
  });
});

test("planGrokTurnRateSamples reconstructs turn tokens/apiDurationMs as a live TPS pair", () => {
  const now = new Date("2026-07-10T00:01:00Z");
  // First turn: 1500 tokens over 10s → 150 TPS.
  const plan = planGrokTurnRateSamples({
    previousTotal: 0,
    newTotal: 1500,
    turns: [{ totalTokens: 1500, apiDurationMs: 10_000 }],
    now,
  });
  expect(plan).toEqual([
    {
      totalTokens: 0,
      tokenDelta: 0,
      cacheReadTokens: 0,
      cacheReadDelta: 0,
      observedAt: "2026-07-10T00:00:50.000Z",
    },
    {
      totalTokens: 1500,
      tokenDelta: 1500,
      cacheReadTokens: 0,
      cacheReadDelta: 0,
      observedAt: "2026-07-10T00:01:00.000Z",
    },
  ]);
  expect(
    calculateTokensPerSecond(
      plan!.map((sample) => ({
        session_id: "s1",
        total_tokens: sample.totalTokens,
        token_delta: sample.tokenDelta,
        observed_at: sample.observedAt,
      })),
      { now },
    ),
  ).toBe(150);

  const split = planGrokTurnRateSamples({
    previousTotal: 0,
    newTotal: 1500,
    previousCacheRead: 0,
    newCacheRead: 1000,
    turns: [
      {
        totalTokens: 1500,
        cacheReadTokens: 1000,
        apiDurationMs: 10_000,
      },
    ],
    now,
  });
  expect(split?.[1]).toMatchObject({ tokenDelta: 500, cacheReadDelta: 1000 });
  expect(
    calculateTokenRates(
      split!.map((sample) => ({
        session_id: "s1",
        total_tokens: sample.totalTokens,
        token_delta: sample.tokenDelta,
        cache_read_tokens: sample.cacheReadTokens,
        cache_read_delta: sample.cacheReadDelta,
        observed_at: sample.observedAt,
      })),
      { now },
    ),
  ).toEqual({ tokensPerSecond: 50, cacheReadTokensPerSecond: 100 });

  // Long turn: span capped to 55s, delta scaled so rate ≈ tokens/duration.
  const long = planGrokTurnRateSamples({
    previousTotal: 0,
    newTotal: 200_000,
    turns: [{ totalTokens: 200_000, apiDurationMs: 200_000 }],
    now,
    maxSpanSeconds: 55,
  });
  expect(long).toHaveLength(2);
  expect(long![1].tokenDelta).toBeCloseTo(200_000 * (55 / 200));
  expect(
    calculateTokensPerSecond(
      long!.map((sample) => ({
        session_id: "s1",
        total_tokens: sample.totalTokens,
        token_delta: sample.tokenDelta,
        observed_at: sample.observedAt,
      })),
      { now },
    ),
  ).toBeCloseTo(1000);

  // Incremental turn: only the new work's duration counts.
  expect(
    newGrokWorkDurationMs(
      [
        { totalTokens: 1000, apiDurationMs: 10_000 },
        { totalTokens: 500, apiDurationMs: 5_000 },
      ],
      1000,
    ),
  ).toBe(5_000);
  expect(
    planGrokTurnRateSamples({
      previousTotal: 1000,
      newTotal: 1500,
      turns: [
        { totalTokens: 1000, apiDurationMs: 10_000 },
        { totalTokens: 500, apiDurationMs: 5_000 },
      ],
      now,
    }),
  ).toMatchObject([
    { totalTokens: 1000, tokenDelta: 0 },
    { totalTokens: 1500, tokenDelta: 500 },
  ]);

  // No advance → no plan (caller records a normal heartbeat sample).
  expect(
    planGrokTurnRateSamples({
      previousTotal: 100,
      newTotal: 100,
      turns: [{ totalTokens: 100, apiDurationMs: 1000 }],
      now,
    }),
  ).toBeNull();
});
