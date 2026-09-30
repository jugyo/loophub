import type { TokenUsage } from "./session-usage.ts";

export interface UsagePrice {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

// USD per million tokens. Rates mirror Anthropic's first-party Claude API pricing
// page as checked on 2026-07-04; unknown models keep token totals with cost_usd=null.
const PRICES: Record<string, UsagePrice> = {
  fable: { input: 10, cacheCreation: 12.5, cacheRead: 1, output: 50 },
  mythos: { input: 10, cacheCreation: 12.5, cacheRead: 1, output: 50 },
  opus: { input: 5, cacheCreation: 6.25, cacheRead: 0.5, output: 25 },
  sonnet: { input: 3, cacheCreation: 3.75, cacheRead: 0.3, output: 15 },
  haiku: { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 },
};

// Claude Opus 5.5 and Fable 5.1 (https://platform.claude.com/docs/en/about-claude/pricing, checked
// 2026-09-29) break from their families' rates: Opus 5.5 is $4 / $5 5m cache write / $20 with cache
// hits at 0.05x input ($0.20), and Fable 5.1 keeps Fable's $10 / $12.50 / $50 but prices cache hits
// at 0.025x input ($0.25). Sonnet 5.5 matches SONNET_5_INTRO_PRICE, which Anthropic made Sonnet 5's
// standard rate, so it shares that entry via the "sonnet-5" match.
const OPUS_55_PRICE: UsagePrice = {
  input: 4,
  cacheCreation: 5,
  cacheRead: 0.2,
  output: 20,
};
const FABLE_51_PRICE: UsagePrice = {
  input: 10,
  cacheCreation: 12.5,
  cacheRead: 0.25,
  output: 50,
};
const SONNET_5_INTRO_PRICE: UsagePrice = {
  input: 2,
  cacheCreation: 2.5,
  cacheRead: 0.2,
  output: 10,
};
const HAIKU_35_PRICE: UsagePrice = {
  input: 0.8,
  cacheCreation: 1,
  cacheRead: 0.08,
  output: 4,
};
const OPUS_LEGACY_4_PRICE: UsagePrice = {
  input: 15,
  cacheCreation: 18.75,
  cacheRead: 1.5,
  output: 75,
};
const GPT_55_PRICE: UsagePrice = {
  input: 5,
  cacheCreation: 5,
  cacheRead: 0.5,
  output: 30,
};
const GPT_54_PRICE: UsagePrice = {
  input: 2.5,
  cacheCreation: 2.5,
  cacheRead: 0.25,
  output: 15,
};
const GPT_54_MINI_PRICE: UsagePrice = {
  input: 0.75,
  cacheCreation: 0.75,
  cacheRead: 0.08,
  output: 4.5,
};
// gpt-5.3-codex-spark itself has NO confirmed per-token API rate: OpenAI's
// pricing page (https://developers.openai.com/codex/pricing, checked
// 2026-07-06) explicitly states it as a ChatGPT Pro research preview
// ("isn't available in the API at launch", "credit rates for this model are
// not final") with no numeric rate listed. The figures below are the
// confirmed OpenAI rate for the sibling gpt-5.3-codex tier (input $1.75 /
// cached $0.175 / output $14.00 per 1M tokens), which third-party trackers
// (e.g. pricepertoken.com) report spark as matching — a working stand-in
// borrowed from a confirmed sibling model, not a confirmed spark-specific
// price. Replace with OpenAI's own spark rate once it is published.
const GPT_53_CODEX_PRICE: UsagePrice = {
  input: 1.75,
  cacheCreation: 1.75,
  cacheRead: 0.175,
  output: 14,
};
// Confirmed OpenAI rate for gpt-5.6-sol (codex) from the OpenAI API pricing
// page (https://developers.openai.com/api/docs/models/gpt-5.6-sol, checked
// 2026-07-10): input $5.00 / output $30.00 per 1M tokens, cache reads at the
// 90% cached-input discount ($0.50), and — new for gpt-5.6+ — cache writes
// billed at 1.25x the uncached input rate ($6.25). Matched narrowly to the
// -sol tier: the sibling gpt-5.6-terra ($2.50) and gpt-5.6-luna ($1.00) tiers
// carry different rates and are out of scope here.
const GPT_56_SOL_PRICE: UsagePrice = {
  input: 5,
  cacheCreation: 6.25,
  cacheRead: 0.5,
  output: 30,
};
// Confirmed OpenAI rate for gpt-6-astra (codex) from the OpenAI API pricing page
// (https://developers.openai.com/api/docs/models/gpt-6-astra, checked 2026-09-09): input $10.00 /
// cached input $1.00 / cache writes $12.50 (1.25x the uncached input rate, as for gpt-5.6+) /
// output $50.00 per 1M tokens. Only that standard rate is stored: prompts over 272K input tokens
// are billed at 2x input and cache rates and 1.5x output for the whole request, and cost is
// resolved per model here with no per-request prompt-size awareness — the same simplification the
// Claude and Grok long-context tiers get.
const GPT_6_ASTRA_PRICE: UsagePrice = {
  input: 10,
  cacheCreation: 12.5,
  cacheRead: 1,
  output: 50,
};
// Confirmed OpenAI rates for the GPT-6 Sol and Luna tiers (checked 2026-09-29):
// https://developers.openai.com/api/docs/models/gpt-6-sol — input $2.00 / cached input $0.20 /
// cache writes $2.50 / output $10.00 per 1M tokens;
// https://developers.openai.com/api/docs/models/gpt-6-luna — input $0.10 / cached input $0.01 /
// cache writes $0.125 / output $0.50 per 1M tokens. As for gpt-6-astra, only the standard rate is
// stored, not the >272K-input tier.
const GPT_6_SOL_PRICE: UsagePrice = {
  input: 2,
  cacheCreation: 2.5,
  cacheRead: 0.2,
  output: 10,
};
const GPT_6_LUNA_PRICE: UsagePrice = {
  input: 0.1,
  cacheCreation: 0.125,
  cacheRead: 0.01,
  output: 0.5,
};
const GPT_56_LUNA_PRICE: UsagePrice = {
  input: 1,
  cacheCreation: 1.25,
  cacheRead: 0.1,
  output: 6,
};

// xAI Grok rates (USD per 1M tokens). Source: https://docs.x.ai/developers/models
// and https://docs.x.ai/developers/pricing (checked 2026-07-17). Models with
// long-context tiers publish a higher rate above a prompt threshold; we store
// the standard (<200k prompt) tier only — same simplification as Claude/GPT
// prices here (no per-request prompt-size awareness).
//
// grok-4.5: https://docs.x.ai/developers/models/grok-4.5
//   input $2.00 / cached input $0.50 / output $6.00
const GROK_45_PRICE: UsagePrice = {
  input: 2,
  cacheCreation: 2,
  cacheRead: 0.5,
  output: 6,
};
// grok-code-fast-1 is an alias of grok-build-0.1
// (https://docs.x.ai/developers/models/grok-code-fast-1):
//   input $1.00 / cached input $0.20 / output $2.00
const GROK_CODE_FAST_PRICE: UsagePrice = {
  input: 1,
  cacheCreation: 1,
  cacheRead: 0.2,
  output: 2,
};
// grok-4.3 family (also the post–May-15-2026 redirect target for retired
// slugs grok-4 / grok-4-fast / grok-3 — see
// https://docs.x.ai/developers/migration/may-15-retirement):
//   input $1.25 / cached input $0.20 / output $2.50
const GROK_43_PRICE: UsagePrice = {
  input: 1.25,
  cacheCreation: 1.25,
  cacheRead: 0.2,
  output: 2.5,
};

export function priceForModel(model: string): UsagePrice | null {
  const m = model.toLowerCase();
  if (m.includes("opus-5-5")) return OPUS_55_PRICE;
  if (m.includes("fable-5-1")) return FABLE_51_PRICE;
  if (m.includes("sonnet-5")) return SONNET_5_INTRO_PRICE;
  if (/opus-4-(8|7|6|5)/.test(m)) return PRICES.opus;
  if (
    m.includes("opus-4-1") ||
    m.includes("claude-opus-4-202") ||
    m === "opus-4"
  )
    return OPUS_LEGACY_4_PRICE;
  if (m.includes("haiku-3-5")) return HAIKU_35_PRICE;
  if (m.includes("fable")) return PRICES.fable;
  if (m.includes("mythos")) return PRICES.mythos;
  if (m.includes("opus")) return PRICES.opus;
  if (m.includes("sonnet")) return PRICES.sonnet;
  if (m.includes("haiku")) return PRICES.haiku;
  if (m.includes("gpt-6-astra")) return GPT_6_ASTRA_PRICE;
  if (m.includes("gpt-6-sol")) return GPT_6_SOL_PRICE;
  if (m.includes("gpt-6-luna")) return GPT_6_LUNA_PRICE;
  if (m.includes("gpt-5.6-sol")) return GPT_56_SOL_PRICE;
  if (m.includes("gpt-5.6-luna")) return GPT_56_LUNA_PRICE;
  if (m.includes("gpt-5.5")) return GPT_55_PRICE;
  if (m.includes("gpt-5.4-mini")) return GPT_54_MINI_PRICE;
  if (m.includes("gpt-5.4")) return GPT_54_PRICE;
  if (m.includes("gpt-5.3-codex-spark")) return GPT_53_CODEX_PRICE;
  // Grok: more-specific model ids first so "grok-4.5" does not fall through to
  // the broader "grok-4" branch, and "grok-4-fast" does not match plain "grok-4".
  if (m.includes("grok-4.5")) return GROK_45_PRICE;
  if (m.includes("grok-code-fast") || m.includes("grok-build"))
    return GROK_CODE_FAST_PRICE;
  if (
    m.includes("grok-4-fast") ||
    m.includes("grok-4-1-fast") ||
    m.includes("grok-4.3") ||
    m.includes("grok-4.20")
  )
    return GROK_43_PRICE;
  // Bare "grok-4" / "grok-4-0709" and "grok-3" are retired API slugs billed at
  // the grok-4.3 redirect rate after 2026-05-15 (see GROK_43_PRICE comment).
  if (m.includes("grok-4") || m.includes("grok-3")) return GROK_43_PRICE;
  return null;
}

export function calculateCostUsd(
  model: string,
  usage: TokenUsage,
): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  return (
    (usage.input_tokens * price.input +
      usage.cache_creation_input_tokens * price.cacheCreation +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.output_tokens * price.output) /
    1_000_000
  );
}
