import { expect, test } from "vitest";
import {
  aggregateUsage,
  calculateCostUsd,
  parseClaudeUsageJsonl,
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
