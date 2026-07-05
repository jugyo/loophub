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

export interface CodexRolloutCandidate extends TranscriptCandidate {
  entries: UsageEntry[];
  startedAtMs: number;
  threadId: string | null;
  parentThreadId: string | null;
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
  if (m.includes("gpt-5.5")) return GPT_55_PRICE;
  if (m.includes("gpt-5.4-mini")) return GPT_54_MINI_PRICE;
  if (m.includes("gpt-5.4")) return GPT_54_PRICE;
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function rolloutPayload(row: Record<string, unknown>): Record<string, unknown> {
  return objectValue(row.payload) ?? row;
}

function rolloutType(
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | null {
  return stringValue(payload.type) ?? stringValue(row.type);
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function rolloutTimestampFromPath(path: string): number | null {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(
    basename(path),
  );
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  ).getTime();
}

export function parseCodexRolloutJsonl(
  text: string,
  messageId = "codex-rollout",
): {
  cwd: string | null;
  startedAtMs: number | null;
  threadId: string | null;
  parentThreadId: string | null;
  entries: UsageEntry[];
} {
  let cwd: string | null = null;
  let model: string | null = null;
  let usage: TokenUsage | null = null;
  let startedAtMs: number | null = null;
  let threadId: string | null = null;
  let parentThreadId: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = objectValue(parsed);
    if (!row) continue;
    const payload = rolloutPayload(row);
    const type = rolloutType(row, payload);
    startedAtMs ??=
      timestampMs(payload.timestamp) ?? timestampMs(row.timestamp);

    if (type === "session_meta") {
      cwd = stringValue(payload.cwd) ?? cwd;
      model = stringValue(payload.model) ?? model;
      threadId = stringValue(payload.id) ?? threadId;
      parentThreadId = stringValue(payload.parent_thread_id) ?? parentThreadId;
      continue;
    }

    if (type === "turn_context") {
      model = stringValue(payload.model) ?? model;
      continue;
    }

    if (type !== "token_count") continue;
    const info = objectValue(payload.info) ?? objectValue(row.info);
    const total =
      objectValue(info?.total_token_usage) ??
      objectValue(payload.total_token_usage) ??
      objectValue(row.total_token_usage);
    if (!total) continue;
    const cacheCreation = tokenCount(total.cache_creation_input_tokens);
    const cacheRead =
      tokenCount(total.cached_input_tokens) +
      tokenCount(total.cache_read_input_tokens);
    const outputTokens =
      typeof total.output_tokens === "number"
        ? tokenCount(total.output_tokens)
        : tokenCount(total.reasoning_output_tokens);
    usage = {
      input_tokens: Math.max(
        0,
        tokenCount(total.input_tokens) - cacheCreation - cacheRead,
      ),
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
      output_tokens: outputTokens,
    };
  }

  if (!usage)
    return { cwd, startedAtMs, threadId, parentThreadId, entries: [] };
  return {
    cwd,
    startedAtMs,
    threadId,
    parentThreadId,
    entries: [
      {
        message_id: messageId,
        model: model ?? "codex",
        ...usage,
      },
    ],
  };
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

export function defaultCodexSessionsDir(): string {
  return join(homedir(), ".codex", "sessions");
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

function walkRolloutFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      walkRolloutFiles(path, out);
      continue;
    }
    if (
      dirent.isFile() &&
      dirent.name.startsWith("rollout-") &&
      dirent.name.endsWith(".jsonl")
    ) {
      out.push(path);
    }
  }
  return out;
}

export function findCodexRollouts(input: {
  cwd: string;
  startedAtMs: number;
  endedBeforeMs?: number | null;
  sessionsDir?: string;
}): CodexRolloutCandidate[] {
  const sessionsDir = input.sessionsDir ?? defaultCodexSessionsDir();
  if (!input.cwd || !existsSync(sessionsDir)) return [];
  const startedAtMs = Number.isFinite(input.startedAtMs)
    ? input.startedAtMs
    : 0;
  const endedBeforeMs =
    typeof input.endedBeforeMs === "number" &&
    Number.isFinite(input.endedBeforeMs)
      ? input.endedBeforeMs
      : null;
  const candidates: CodexRolloutCandidate[] = [];

  for (const path of walkRolloutFiles(sessionsDir)) {
    const st = statSync(path);
    if (!st.isFile()) continue;
    const parsed = parseCodexRolloutJsonl(readFileSync(path, "utf8"), path);
    const rolloutStartedAtMs =
      parsed.startedAtMs ?? rolloutTimestampFromPath(path);
    if (rolloutStartedAtMs == null) continue;
    if (rolloutStartedAtMs < startedAtMs) continue;
    if (parsed.cwd !== input.cwd || parsed.entries.length === 0) continue;
    candidates.push({
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      startedAtMs: rolloutStartedAtMs,
      threadId: parsed.threadId,
      parentThreadId: parsed.parentThreadId,
      entries: parsed.entries,
    });
  }

  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const roots = candidates.filter(
    (x) =>
      !x.parentThreadId &&
      (endedBeforeMs == null || x.startedAtMs < endedBeforeMs),
  );
  if (roots.length !== 1) return [];
  const root = roots[0];
  return candidates.filter(
    (x) =>
      x.path === root.path ||
      (root.threadId != null &&
        x.parentThreadId === root.threadId &&
        x.startedAtMs >= root.startedAtMs),
  );
}
