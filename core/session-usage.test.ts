import { expect, test } from "vitest";
import {
  aggregateUsage,
  calculateCostUsd,
  parseClaudeSubagentJsonl,
  parseClaudeUsageJsonl,
  parseCodexRolloutJsonl,
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

  expect(sonnet.cost_usd).toBeCloseTo(0.000615);
  expect(unknown.cost_usd).toBeNull();
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
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            reasoning_output_tokens: 5,
          },
        },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 50,
            output_tokens: 12,
            reasoning_output_tokens: 6,
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
  });
  expect(calculateCostUsd("gpt-5.5", parsed.entries[0])).toBeCloseTo(0.000735);
});
