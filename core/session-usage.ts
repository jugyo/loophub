import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface TokenUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface UsageEntry extends TokenUsage {
  message_id: string;
  model: string;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  cost_usd: number | null;
}

export interface UsagePrice {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export interface TranscriptCandidate {
  path: string;
  size: number;
  mtimeMs: number;
}

export const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
};

// USD per million tokens. Rates mirror Anthropic's first-party Claude API pricing
// page as checked on 2026-07-04; unknown models keep token totals with cost_usd=null.
const PRICES: Record<string, UsagePrice> = {
  fable: { input: 10, cacheCreation: 12.5, cacheRead: 1, output: 50 },
  mythos: { input: 10, cacheCreation: 12.5, cacheRead: 1, output: 50 },
  opus: { input: 5, cacheCreation: 6.25, cacheRead: 0.5, output: 25 },
  sonnet: { input: 3, cacheCreation: 3.75, cacheRead: 0.3, output: 15 },
  haiku: { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 },
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

export function priceForModel(model: string): UsagePrice | null {
  const m = model.toLowerCase();
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

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

export function parseClaudeUsageJsonl(text: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const message = row?.message;
    const usage = message?.usage;
    const messageId = message?.id;
    const model = message?.model ?? row?.model;
    if (
      row?.type !== "assistant" ||
      !usage ||
      typeof messageId !== "string" ||
      typeof model !== "string"
    ) {
      continue;
    }
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    entries.push({
      message_id: messageId,
      model,
      input_tokens: tokenCount(usage.input_tokens),
      cache_creation_input_tokens: tokenCount(
        usage.cache_creation_input_tokens,
      ),
      cache_read_input_tokens: tokenCount(usage.cache_read_input_tokens),
      output_tokens: tokenCount(usage.output_tokens),
    });
  }
  return entries;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

export function aggregateUsage(entries: UsageEntry[]): ModelUsage[] {
  const byModel = new Map<string, TokenUsage>();
  for (const entry of entries) {
    byModel.set(
      entry.model,
      addUsage(byModel.get(entry.model) ?? ZERO_USAGE, entry),
    );
  }
  return [...byModel.entries()].map(([model, usage]) => ({
    model,
    ...usage,
    cost_usd: calculateCostUsd(model, usage),
  }));
}

export function defaultClaudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function findClaudeTranscript(
  externalSession: string,
  projectsDir = defaultClaudeProjectsDir(),
): TranscriptCandidate | null {
  if (!externalSession || !existsSync(projectsDir)) return null;
  const filename = `${basename(externalSession)}.jsonl`;
  const matches: TranscriptCandidate[] = [];
  for (const dirent of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const path = join(projectsDir, dirent.name, filename);
    if (!existsSync(path)) continue;
    const st = statSync(path);
    if (!st.isFile()) continue;
    matches.push({ path, size: st.size, mtimeMs: st.mtimeMs });
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0] ?? null;
}

export function readTranscriptSlice(path: string, offset: number): string {
  const buf = readFileSync(path);
  return buf.subarray(Math.max(0, Math.min(offset, buf.length))).toString();
}
