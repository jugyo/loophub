import { expect, test } from "vitest";
import {
  aggregateUsage,
  calculateCostUsd,
  parseClaudeSubagentJsonl,
  parseClaudeUsageJsonl,
  parseCodexRolloutJsonl,
  priceForModel,
} from "./session-usage.ts";

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

test("priceForModel prices gpt-5.3-codex-spark without breaking the gpt-5.4-mini/gpt-5.4 order", () => {
  expect(priceForModel("gpt-5.3-codex-spark")).toMatchObject({
    input: 1.75,
    cacheCreation: 1.75,
    cacheRead: 0.175,
    output: 14,
  });
  expect(priceForModel("gpt-5.4-mini")).toMatchObject({ input: 0.75 });
  expect(priceForModel("gpt-5.4")).toMatchObject({ input: 2.5 });
});
