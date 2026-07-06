import { createHash } from "node:crypto";
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

export interface SubagentUsage extends ModelUsage {
  source_id: string;
  parent_source_id: string | null;
  label: string | null;
  kind: string;
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

export interface ClaudeSubagentTranscript extends TranscriptCandidate {
  sourceId: string;
  parentSourceId: string | null;
  label: string | null;
  kind: "claude-sidechain";
  entries: UsageEntry[];
}

export interface ClaudeSubagentTranscriptCandidate extends TranscriptCandidate {
  fallbackSourceId: string;
}

export interface ClaudeTranscriptIndex {
  projectsDir: string;
  byFilename: Map<string, TranscriptCandidate[]>;
}

export interface CodexRolloutCandidate extends TranscriptCandidate {
  entries: UsageEntry[];
  startedAtMs: number;
  threadId: string | null;
  parentThreadId: string | null;
}

interface ParsedCodexRollout extends CodexRolloutCandidate {
  cwd: string | null;
}

interface CachedCodexRollout {
  size: number;
  mtimeMs: number;
  parsed: ParsedCodexRollout | null;
}

export interface CodexRolloutScan {
  sessionsDir: string;
  files: TranscriptCandidate[];
  fingerprint: string;
}

const codexRolloutCache = new Map<string, CachedCodexRollout>();
const codexScanParsedByCwd = new WeakMap<
  CodexRolloutScan,
  Map<string, ParsedCodexRollout[]>
>();

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

export function parseClaudeSubagentJsonl(
  text: string,
  fallbackSourceId: string,
): Omit<ClaudeSubagentTranscript, "path" | "size" | "mtimeMs"> {
  let sourceId: string | null = null;
  let parentSourceId: string | null = null;
  let attributionAgent: string | null = null;
  let attributionSkill: string | null = null;
  let roleLabel: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    sourceId ??= stringValue(row?.agentId);
    parentSourceId ??= stringValue(row?.sessionId);
    attributionAgent ??= stringValue(row?.attributionAgent);
    attributionSkill ??= stringValue(row?.attributionSkill);
    roleLabel ??= knownRoleLabelFromPrompt(row?.message?.content);
  }

  const label =
    roleLabel ??
    (attributionAgent && attributionSkill
      ? `${attributionAgent} / ${attributionSkill}`
      : (attributionAgent ?? attributionSkill ?? sourceId ?? fallbackSourceId));
  return {
    sourceId: sourceId ?? fallbackSourceId,
    parentSourceId,
    label: truncateLabel(label),
    kind: "claude-sidechain",
    entries: parseClaudeUsageJsonl(text),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function truncateLabel(value: string | null, max = 160): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

function knownRoleLabelFromPrompt(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const firstLine = content
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  const match = /^Role:\s*([A-Za-z][A-Za-z /_-]{0,80})(?:\s*\(|\s*[-—]|$)/.exec(
    firstLine ?? "",
  );
  const role = match?.[1]?.toLowerCase();
  if (!role) return null;
  if (/\bquality\b|\bbugbot\b/.test(role)) return "Quality reviewer";
  if (/\bsecurity\b/.test(role)) return "Security reviewer";
  if (/\bacceptance\b/.test(role)) return "Acceptance reviewer";
  if (/\bdocumentation\b|\bdocs?\b/.test(role)) return "Documentation reviewer";
  if (/\bcode\b/.test(role)) return "Code reviewer";
  return null;
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

export function createClaudeTranscriptIndex(
  projectsDir = defaultClaudeProjectsDir(),
  externalSessions?: readonly string[],
): ClaudeTranscriptIndex {
  const byFilename = new Map<string, TranscriptCandidate[]>();
  if (!existsSync(projectsDir)) return { projectsDir, byFilename };
  const wanted = externalSessions
    ? new Set(
        externalSessions
          .filter((session) => session)
          .map((session) => `${basename(session)}.jsonl`),
      )
    : null;

  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projectsDir, project.name);
    for (const file of readdirSync(projectPath, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      if (wanted && !wanted.has(file.name)) continue;
      const path = join(projectPath, file.name);
      const st = statSync(path);
      if (!st.isFile()) continue;
      const candidates = byFilename.get(file.name) ?? [];
      candidates.push({ path, size: st.size, mtimeMs: st.mtimeMs });
      byFilename.set(file.name, candidates);
    }
  }

  for (const candidates of byFilename.values()) {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  return { projectsDir, byFilename };
}

export function findClaudeTranscript(
  externalSession: string,
  projectsDir = defaultClaudeProjectsDir(),
  index?: ClaudeTranscriptIndex,
): TranscriptCandidate | null {
  if (!externalSession || !existsSync(projectsDir)) return null;
  const filename = `${basename(externalSession)}.jsonl`;
  if (index) return index.byFilename.get(filename)?.[0] ?? null;
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

export function findClaudeSubagentTranscriptCandidates(
  transcript: TranscriptCandidate,
): ClaudeSubagentTranscriptCandidate[] {
  const sessionDir = transcript.path.replace(/\.jsonl$/, "");
  const subagentsDir = join(sessionDir, "subagents");
  if (!existsSync(subagentsDir)) return [];
  const out: ClaudeSubagentTranscriptCandidate[] = [];
  for (const dirent of readdirSync(subagentsDir, { withFileTypes: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) continue;
    const path = join(subagentsDir, dirent.name);
    const st = statSync(path);
    if (!st.isFile()) continue;
    out.push({
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      fallbackSourceId: dirent.name.replace(/\.jsonl$/, ""),
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function parseClaudeSubagentTranscript(
  file: ClaudeSubagentTranscriptCandidate,
): ClaudeSubagentTranscript | null {
  const parsed = parseClaudeSubagentJsonl(
    readFileSync(file.path, "utf8"),
    file.fallbackSourceId,
  );
  if (parsed.entries.length === 0) return null;
  return {
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ...parsed,
  };
}

export function findClaudeSubagentTranscripts(
  transcript: TranscriptCandidate,
): ClaudeSubagentTranscript[] {
  return findClaudeSubagentTranscriptCandidates(transcript)
    .map(parseClaudeSubagentTranscript)
    .filter((x): x is ClaudeSubagentTranscript => x != null);
}

export function readTranscriptSlice(path: string, offset: number): string {
  const buf = readFileSync(path);
  return buf.subarray(Math.max(0, Math.min(offset, buf.length))).toString();
}

function walkRolloutFiles(
  dir: string,
  out: TranscriptCandidate[] = [],
): TranscriptCandidate[] {
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
      const st = statSync(path);
      if (st.isFile()) out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

function rolloutScanFingerprint(files: TranscriptCandidate[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(String(file.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function pruneCodexRolloutCache(files: TranscriptCandidate[]): void {
  const current = new Set(files.map((file) => file.path));
  for (const path of codexRolloutCache.keys()) {
    if (!current.has(path)) codexRolloutCache.delete(path);
  }
}

export function createCodexRolloutScan(
  sessionsDir = defaultCodexSessionsDir(),
): CodexRolloutScan {
  const files = existsSync(sessionsDir)
    ? walkRolloutFiles(sessionsDir).sort((a, b) => a.path.localeCompare(b.path))
    : [];
  pruneCodexRolloutCache(files);
  return {
    sessionsDir,
    files,
    fingerprint: rolloutScanFingerprint(files),
  };
}

function parseCachedCodexRollout(
  file: TranscriptCandidate,
): ParsedCodexRollout | null {
  const cached = codexRolloutCache.get(file.path);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
    return cached.parsed;
  }

  const parsed = parseCodexRolloutJsonl(
    readFileSync(file.path, "utf8"),
    file.path,
  );
  const startedAtMs = parsed.startedAtMs ?? rolloutTimestampFromPath(file.path);
  const result =
    startedAtMs == null
      ? null
      : {
          path: file.path,
          size: file.size,
          mtimeMs: file.mtimeMs,
          cwd: parsed.cwd,
          startedAtMs,
          threadId: parsed.threadId,
          parentThreadId: parsed.parentThreadId,
          entries: parsed.entries,
        };
  codexRolloutCache.set(file.path, {
    size: file.size,
    mtimeMs: file.mtimeMs,
    parsed: result,
  });
  return result;
}

function parsedRolloutsByCwd(
  scan: CodexRolloutScan,
): Map<string, ParsedCodexRollout[]> {
  const cached = codexScanParsedByCwd.get(scan);
  if (cached) return cached;

  const byCwd = new Map<string, ParsedCodexRollout[]>();
  for (const file of scan.files) {
    const parsed = parseCachedCodexRollout(file);
    if (!parsed?.cwd || parsed.entries.length === 0) continue;
    const list = byCwd.get(parsed.cwd) ?? [];
    list.push(parsed);
    byCwd.set(parsed.cwd, list);
  }
  codexScanParsedByCwd.set(scan, byCwd);
  return byCwd;
}

export function findCodexRollouts(input: {
  cwd: string;
  startedAtMs: number;
  endedBeforeMs?: number | null;
  sessionsDir?: string;
  scan?: CodexRolloutScan;
}): CodexRolloutCandidate[] {
  const scan =
    input.scan ??
    createCodexRolloutScan(input.sessionsDir ?? defaultCodexSessionsDir());
  if (!input.cwd || scan.files.length === 0) return [];
  const startedAtMs = Number.isFinite(input.startedAtMs)
    ? input.startedAtMs
    : 0;
  const endedBeforeMs =
    typeof input.endedBeforeMs === "number" &&
    Number.isFinite(input.endedBeforeMs)
      ? input.endedBeforeMs
      : null;
  const candidates: CodexRolloutCandidate[] = [];

  for (const parsed of parsedRolloutsByCwd(scan).get(input.cwd) ?? []) {
    if (parsed.startedAtMs < startedAtMs) continue;
    candidates.push({
      path: parsed.path,
      size: parsed.size,
      mtimeMs: parsed.mtimeMs,
      startedAtMs: parsed.startedAtMs,
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
