import { expect, test } from "vitest";
import { calculateCostUsd, priceForModel } from "./pricing.ts";

test("priceForModel prices gpt-5.3-codex-spark without breaking the gpt-5.4-mini/gpt-5.4 order", () => {
  expect(priceForModel("gpt-5.3-codex-spark")).toMatchObject({
    input: 1.75,
    cacheCreation: 1.75,
    cacheRead: 0.175,
    output: 14,
  });
  expect(priceForModel("gpt-5.4-mini")).toMatchObject({ input: 0.75 });
  expect(priceForModel("gpt-5.4")).toMatchObject({ input: 2.5 });
  expect(priceForModel("future-gpt-5.3-codex-unknown")).toBeNull();
});

test("priceForModel calculates cost for the fable model", () => {
  expect(priceForModel("claude-fable-5")).toMatchObject({
    input: 10,
    cacheCreation: 12.5,
    cacheRead: 1,
    output: 50,
  });
  expect(
    calculateCostUsd("claude-fable-5", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000,
    }),
  ).toBeCloseTo(60);
});

test("priceForModel prices gpt-5.6-sol from its confirmed OpenAI rate", () => {
  expect(priceForModel("gpt-5.6-sol")).toMatchObject({
    input: 5,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    output: 30,
  });
  // A gpt-5.6-sol session yields a non-null aggregated cost (previously null,
  // which forced the PR agent-cost total and the Web UI to "n/a").
  expect(
    calculateCostUsd("gpt-5.6-sol", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000,
    }),
  ).toBeCloseTo(35);
});

test("priceForModel prices gpt-5.6-luna for Codex agent cost reporting", () => {
  expect(priceForModel("gpt-5.6-luna")).toMatchObject({
    input: 1,
    cacheCreation: 1.25,
    cacheRead: 0.1,
    output: 6,
  });
  expect(
    calculateCostUsd("gpt-5.6-luna", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000,
    }),
  ).toBeCloseTo(7);
});

test("adding gpt-5.6-sol leaves the other codex/claude rates unchanged", () => {
  expect(priceForModel("gpt-5.5")).toMatchObject({ input: 5, output: 30 });
  expect(priceForModel("gpt-5.4-mini")).toMatchObject({ input: 0.75 });
  expect(priceForModel("gpt-5.4")).toMatchObject({ input: 2.5 });
  expect(priceForModel("gpt-5.3-codex-spark")).toMatchObject({ input: 1.75 });
  expect(priceForModel("claude-opus-4-8")).toMatchObject({ input: 5 });
  expect(priceForModel("claude-sonnet-5")).toMatchObject({ input: 2 });
  // Unrelated gpt-5.6 tiers stay unpriced (out of scope) instead of borrowing
  // the -sol rate via an over-broad match.
  expect(priceForModel("gpt-5.6-terra")).toBeNull();
});

test("priceForModel prices claude-opus-5 at the standard opus rate via the opus fallback", () => {
  expect(priceForModel("claude-opus-5")).toMatchObject({
    input: 5,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    output: 25,
  });
});

test("priceForModel prices known Grok models and leaves unknown Grok models null", () => {
  expect(priceForModel("grok-4.5")).toMatchObject({
    input: 2,
    cacheRead: 0.5,
    output: 6,
  });
  expect(priceForModel("grok-code-fast-1")).toMatchObject({
    input: 1,
    cacheRead: 0.2,
    output: 2,
  });
  expect(priceForModel("grok-4")).toMatchObject({ input: 1.25, output: 2.5 });
  expect(priceForModel("grok-4-fast")).toMatchObject({
    input: 1.25,
    output: 2.5,
  });
  expect(priceForModel("grok-3")).toMatchObject({ input: 1.25, output: 2.5 });
  expect(priceForModel("grok-unknown-future")).toBeNull();

  expect(
    calculateCostUsd("grok-4.5", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000,
    }),
  ).toBeCloseTo(8);
  expect(
    calculateCostUsd("grok-unknown-future", {
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 10,
    }),
  ).toBeNull();
});

test("OpenCode provider/model ids price known models and leave free/unknown models null", () => {
  // OpenCode records models as provider/model; pricing matches on the model id substring.
  expect(priceForModel("anthropic/claude-sonnet-4-6")).toMatchObject({
    input: 3,
    output: 15,
  });
  expect(
    priceForModel("amazon-bedrock/us.anthropic.claude-sonnet-4-6"),
  ).toMatchObject({
    input: 3,
    output: 15,
  });
  expect(priceForModel("opencode/big-pickle")).toBeNull();
  expect(
    calculateCostUsd("opencode/big-pickle", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000,
    }),
  ).toBeNull();
  expect(
    calculateCostUsd("anthropic/claude-sonnet-4-6", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000,
    }),
  ).toBeCloseTo(18);
});

test("Cursor usage keeps ambiguous Auto and unknown slugs unpriced", () => {
  expect(priceForModel("cursor:auto")).toBeNull();
  expect(
    calculateCostUsd("cursor:auto", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }),
  ).toBeNull();
  expect(priceForModel("cursor:gpt-5.6-sol-high")).toEqual({
    input: 5,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    output: 30,
  });
  expect(priceForModel("cursor:gpt-5.3-codex-high-fast[1m]")).toEqual({
    input: 1.75,
    cacheCreation: 1.75,
    cacheRead: 0.175,
    output: 14,
  });
  expect(priceForModel("cursor:claude-opus-5-thinking-high")).toEqual({
    input: 5,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    output: 25,
  });
  expect(priceForModel("cursor:composer-2.5")).toBeNull();
  expect(priceForModel("cursor:unknown-gpt-5.6-sol-future")).toBeNull();
  expect(
    calculateCostUsd("cursor:unknown", {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }),
  ).toBeNull();
});
