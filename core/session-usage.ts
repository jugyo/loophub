import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { calculateCostUsd } from "./pricing.ts";

// OpenCode stores session usage in its own SQLite DB. Load node:sqlite the same way
// core/db.ts does so bundler transformers do not try to resolve the experimental
// specifier as a package.
const { DatabaseSync: OpencodeDatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;

// The model pricing catalog lives in ./pricing.ts (SSOT for per-model rates).
// Re-exported here so existing importers keep resolving these from
// ./session-usage.ts unchanged.
export { calculateCostUsd, priceForModel, type UsagePrice } from "./pricing.ts";

export interface TokenUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface UsageEntry extends TokenUsage {
  message_id: string;
  model: string;
  context_usage_percent?: number | null;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  cost_usd: number | null;
  context_usage_percent?: number | null;
}

export interface SubagentUsage extends ModelUsage {
  source_id: string;
  parent_source_id: string | null;
  label: string | null;
  kind: string;
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
  observations: CodexTokenObservation[];
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

const IGNORED_CODEX_ROLLOUT_MODELS = new Set(["codex-auto-review"]);

function isIgnoredCodexRolloutModel(model: string | null): boolean {
  return model != null && IGNORED_CODEX_ROLLOUT_MODELS.has(model.toLowerCase());
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

interface CodexTokenObservation {
  model: string | null;
  usage: TokenUsage;
  modelContextWindow: number | null;
  lastTotalTokens: number | null;
}

export function claudeContextWindowForModel(model: string): number | null {
  const m = model.toLowerCase();
  // Claude Code model configuration docs: Opus 5, Fable 5, Sonnet 5, Opus 4.6+,
  // and Sonnet 4.6 support 1M-token long sessions; Claude 3.x and older
  // Claude 4 releases use 200k. Unknown/future model names stay null.
  if (m.includes("opus-5")) return 1_000_000;
  if (m.includes("fable-5")) return 1_000_000;
  if (m.includes("sonnet-5")) return 1_000_000;
  if (m.includes("sonnet-4-6")) return 1_000_000;
  const opus4 = /opus-4-(\d{1,2})(?:\D|$)/.exec(m);
  if (opus4 && Number(opus4[1]) >= 6) return 1_000_000;
  if (m.includes("haiku-4-5")) return 200_000;
  if (m.includes("sonnet-4")) return 200_000;
  if (m.includes("opus-4")) return 200_000;
  if (/\bclaude-3(?:-\d+)?-(?:haiku|sonnet|opus)\b/.test(m)) return 200_000;
  if (/\b(?:haiku|sonnet|opus)-3(?:-\d+)?\b/.test(m)) return 200_000;
  return null;
}

function claudeContextUsagePercent(
  model: string,
  usage: unknown,
): number | null {
  const window = claudeContextWindowForModel(model);
  if (window == null) return null;
  const u = objectValue(usage);
  if (!u) return null;
  if (
    ![
      u.input_tokens,
      u.cache_creation_input_tokens,
      u.cache_read_input_tokens,
    ].some((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return null;
  }
  // Claude transcript message.usage is the stable per-request token source.
  // Current input context is represented by the non-cached input tokens plus
  // prompt-cache creation/read buckets; statusline context_window shapes are
  // not transcript fields and are intentionally ignored.
  const current =
    tokenCount(u.input_tokens) +
    tokenCount(u.cache_creation_input_tokens) +
    tokenCount(u.cache_read_input_tokens);
  return (current / window) * 100;
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
      context_usage_percent: claudeContextUsagePercent(model, usage),
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

function usageDelta(
  current: TokenUsage,
  previous: TokenUsage | null,
): TokenUsage {
  if (!previous) return current;
  const delta = {
    input_tokens: current.input_tokens - previous.input_tokens,
    cache_creation_input_tokens:
      current.cache_creation_input_tokens -
      previous.cache_creation_input_tokens,
    cache_read_input_tokens:
      current.cache_read_input_tokens - previous.cache_read_input_tokens,
    output_tokens: current.output_tokens - previous.output_tokens,
  };
  return Object.values(delta).some((value) => value < 0) ? current : delta;
}

// Map one Grok turn_completed.usage (or modelUsage[*]) object onto the shared
// session_usage columns. Grok reports camelCase totals:
//   inputTokens / outputTokens / cachedReadTokens / reasoningTokens
// inputTokens is total input including cached reads, so non-cached input is
// inputTokens - cachedReadTokens. There is no cache-write field. reasoningTokens
// have no dedicated column — fold into output_tokens (documented on the PR);
// xAI bills them as a separate token type, and the model's output rate is the
// best available estimate without schema expansion.
function grokTokenUsageFromRaw(u: Record<string, unknown>): TokenUsage {
  const inputTokens = tokenCount(u.inputTokens);
  const cachedRead = tokenCount(u.cachedReadTokens);
  const outputTokens = tokenCount(u.outputTokens);
  const reasoningTokens = tokenCount(u.reasoningTokens);
  return {
    input_tokens: Math.max(0, inputTokens - cachedRead),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedRead,
    output_tokens: outputTokens + reasoningTokens,
  };
}

// One Grok turn_completed observation, carrying the per-model billed usage the
// row reported.
export interface GrokTurnUsage {
  promptId: string;
  models: Map<string, TokenUsage>;
}

// Parse Grok Build `updates.jsonl` into per-prompt turns. Each
// `sessionUpdate: turn_completed` row carries per-prompt usage (often with
// modelUsage[<modelId>]); the same prompt_id may appear more than once as a
// multi-turn prompt progresses, so the latest row for a prompt_id wins.
export function parseGrokTurnUsages(text: string): GrokTurnUsage[] {
  const byPrompt = new Map<string, Map<string, TokenUsage>>();

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
    const params = objectValue(row.params);
    const update = objectValue(params?.update) ?? objectValue(row.update);
    if (!update) continue;
    if (stringValue(update.sessionUpdate) !== "turn_completed") continue;
    const usage = objectValue(update.usage);
    if (!usage) continue;

    const meta = objectValue(params?._meta);
    const promptId =
      stringValue(update.prompt_id) ??
      stringValue(meta?.eventId) ??
      `grok-turn-${byPrompt.size}`;

    const models = new Map<string, TokenUsage>();
    const modelUsage = objectValue(usage.modelUsage);
    if (modelUsage) {
      for (const [model, raw] of Object.entries(modelUsage)) {
        const mu = objectValue(raw);
        if (!mu || !stringValue(model)) continue;
        const tokens = grokTokenUsageFromRaw(mu);
        if (!hasTokenUsage(tokens)) continue;
        models.set(model, tokens);
      }
    }
    if (models.size === 0) {
      const tokens = grokTokenUsageFromRaw(usage);
      if (hasTokenUsage(tokens)) models.set("grok", tokens);
    }
    if (models.size === 0) continue;
    byPrompt.set(promptId, models);
  }

  return [...byPrompt].map(([promptId, models]) => ({ promptId, models }));
}

// Aggregate per-prompt turns into the flat UsageEntry[] shape used by cost
// sync.
export function parseGrokUpdatesJsonl(
  text: string,
  messageId = "grok-updates",
): UsageEntry[] {
  const totals = new Map<string, TokenUsage>();
  for (const turn of parseGrokTurnUsages(text)) {
    for (const [model, usage] of turn.models) {
      totals.set(model, addUsage(totals.get(model) ?? ZERO_USAGE, usage));
    }
  }

  return [...totals.entries()].map(([model, usage]) => ({
    message_id: messageId,
    model,
    ...usage,
  }));
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
  observations: CodexTokenObservation[];
} {
  let cwd: string | null = null;
  let model: string | null = null;
  let modelContextWindow: number | null = null;
  let startedAtMs: number | null = null;
  let threadId: string | null = null;
  let parentThreadId: string | null = null;
  let hasSessionIdentity = false;
  const observations: CodexTokenObservation[] = [];

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
      // A fork rollout starts with its own metadata, followed by a copy of the parent's transcript
      // (including the parent's session_meta). Only the first valid row identifies this rollout.
      if (!hasSessionIdentity) {
        const id = stringValue(payload.id);
        if (id) {
          threadId = id;
          parentThreadId = stringValue(payload.parent_thread_id);
          hasSessionIdentity = true;
        }
      }
      continue;
    }

    if (type === "turn_context") {
      model = stringValue(payload.model) ?? model;
      continue;
    }

    if (type === "task_started") {
      modelContextWindow =
        positiveNumber(payload.model_context_window) ?? modelContextWindow;
      continue;
    }

    if (type !== "token_count") continue;
    const info = objectValue(payload.info) ?? objectValue(row.info);
    modelContextWindow =
      positiveNumber(info?.model_context_window) ??
      positiveNumber(payload.model_context_window) ??
      modelContextWindow;
    const lastUsage =
      objectValue(info?.last_token_usage) ??
      objectValue(payload.last_token_usage) ??
      objectValue(row.last_token_usage);
    const lastTotalTokens = nonNegativeNumber(lastUsage?.total_tokens);
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
    const currentUsage = {
      input_tokens: Math.max(
        0,
        tokenCount(total.input_tokens) - cacheCreation - cacheRead,
      ),
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
      output_tokens: outputTokens,
    };
    observations.push({
      model,
      usage: currentUsage,
      modelContextWindow,
      lastTotalTokens,
    });
  }

  const normalizedObservations =
    backfillLeadingCodexObservationModels(observations);
  return {
    cwd,
    startedAtMs,
    threadId,
    parentThreadId,
    entries: codexUsageEntries(normalizedObservations, messageId),
    observations: normalizedObservations,
  };
}

function backfillLeadingCodexObservationModels(
  observations: CodexTokenObservation[],
): CodexTokenObservation[] {
  // Forked Codex rollouts can emit cumulative token counts before their first turn_context. Those
  // counts use the same model once the context arrives; leaving them as the synthetic "codex"
  // model would add an unknown-cost row and make the otherwise-known session total indeterminate.
  const firstKnownModel = observations.find(
    (observation) => observation.model != null,
  )?.model;
  if (!firstKnownModel) return observations;

  let reachedKnownModel = false;
  return observations.map((observation) => {
    if (observation.model != null) reachedKnownModel = true;
    return !reachedKnownModel && observation.model == null
      ? { ...observation, model: firstKnownModel }
      : observation;
  });
}

function codexUsageEntries(
  observations: CodexTokenObservation[],
  messageId: string,
  inheritedPrefixLength = 0,
): UsageEntry[] {
  const usageByModel = new Map<string, TokenUsage>();
  const contextByModel = new Map<string, number>();
  let previousUsage =
    inheritedPrefixLength > 0
      ? observations[inheritedPrefixLength - 1]?.usage
      : null;

  for (const observation of observations.slice(inheritedPrefixLength)) {
    const delta = usageDelta(observation.usage, previousUsage);
    previousUsage = observation.usage;
    if (isIgnoredCodexRolloutModel(observation.model)) continue;
    const usageModel = observation.model ?? "codex";
    usageByModel.set(
      usageModel,
      addUsage(usageByModel.get(usageModel) ?? ZERO_USAGE, delta),
    );
    if (
      observation.modelContextWindow != null &&
      observation.lastTotalTokens != null
    ) {
      contextByModel.set(
        usageModel,
        Math.max(
          contextByModel.get(usageModel) ?? 0,
          (observation.lastTotalTokens / observation.modelContextWindow) * 100,
        ),
      );
    }
  }

  return [...usageByModel.entries()].map(([model, usage]) => ({
    message_id: messageId,
    model,
    context_usage_percent: contextByModel.get(model) ?? null,
    ...usage,
  }));
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

function hasTokenUsage(usage: TokenUsage): boolean {
  return (
    usage.input_tokens > 0 ||
    usage.cache_creation_input_tokens > 0 ||
    usage.cache_read_input_tokens > 0 ||
    usage.output_tokens > 0
  );
}

export function aggregateUsage(entries: UsageEntry[]): ModelUsage[] {
  const byModel = new Map<string, TokenUsage>();
  const contextByModel = new Map<string, number>();
  for (const entry of entries) {
    byModel.set(
      entry.model,
      addUsage(byModel.get(entry.model) ?? ZERO_USAGE, entry),
    );
    if (
      typeof entry.context_usage_percent === "number" &&
      Number.isFinite(entry.context_usage_percent)
    ) {
      contextByModel.set(
        entry.model,
        Math.max(
          contextByModel.get(entry.model) ?? 0,
          entry.context_usage_percent,
        ),
      );
    }
  }
  return [...byModel.entries()]
    .filter(([, usage]) => hasTokenUsage(usage))
    .map(([model, usage]) => ({
      model,
      ...usage,
      cost_usd: calculateCostUsd(model, usage),
      context_usage_percent: contextByModel.get(model) ?? null,
    }));
}

export function defaultClaudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function defaultCodexSessionsDir(): string {
  return join(homedir(), ".codex", "sessions");
}

export function defaultGrokSessionsDir(): string {
  return join(homedir(), ".grok", "sessions");
}

// OpenCode 1.18.x persists sessions in a single SQLite database under the XDG data
// home (default ~/.local/share/opencode/opencode.db). Token totals live on both the
// session row and assistant message JSON; model ids are provider/model pairs.
export function defaultOpencodeDbPath(): string {
  const dataHome =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

// Grok Build stores sessions under ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/.
export function encodeGrokSessionCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

export interface GrokSessionCandidate extends TranscriptCandidate {
  sessionId: string;
  entries: UsageEntry[];
}

export interface OpencodeSessionCandidate extends TranscriptCandidate {
  sessionId: string;
  parentSessionId: string | null;
  directory: string;
  entries: UsageEntry[];
}

export function createClaudeTranscriptIndex(
  projectsDir = defaultClaudeProjectsDir(),
  externalSessions?: readonly string[],
): ClaudeTranscriptIndex {
  const byFilename = new Map<string, TranscriptCandidate[]>();
  if (!existsSync(projectsDir)) return { projectsDir, byFilename };
  const wanted = externalSessions
    ? [
        ...new Set(
          externalSessions
            .filter((session) => session)
            .map((session) => `${basename(session)}.jsonl`),
        ),
      ]
    : null;

  const addCandidate = (projectPath: string, filename: string) => {
    const path = join(projectPath, filename);
    const st = statSync(path);
    if (!st.isFile()) return;
    const candidates = byFilename.get(filename) ?? [];
    candidates.push({ path, size: st.size, mtimeMs: st.mtimeMs });
    byFilename.set(filename, candidates);
  };

  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projectsDir, project.name);
    if (wanted) {
      // Direct-stat only the requested transcript filenames instead of enumerating every .jsonl in
      // the project dir — the sweep asks for a handful of sessions but a project can accumulate
      // thousands of transcripts (#1119).
      for (const filename of wanted) {
        if (!existsSync(join(projectPath, filename))) continue;
        addCandidate(projectPath, filename);
      }
      continue;
    }
    for (const file of readdirSync(projectPath, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      addCandidate(projectPath, file.name);
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
          observations: parsed.observations,
        };
  codexRolloutCache.set(file.path, {
    size: file.size,
    mtimeMs: file.mtimeMs,
    parsed: result,
  });
  return result;
}

function sameCodexTokenObservation(
  a: CodexTokenObservation,
  b: CodexTokenObservation,
): boolean {
  return (
    a.model === b.model &&
    a.usage.input_tokens === b.usage.input_tokens &&
    a.usage.cache_creation_input_tokens ===
      b.usage.cache_creation_input_tokens &&
    a.usage.cache_read_input_tokens === b.usage.cache_read_input_tokens &&
    a.usage.output_tokens === b.usage.output_tokens
  );
}

function inheritedCodexPrefixLength(
  child: ParsedCodexRollout,
  parent: ParsedCodexRollout,
): number {
  const length = Math.min(
    child.observations.length,
    parent.observations.length,
  );
  let shared = 0;
  while (
    shared < length &&
    sameCodexTokenObservation(
      child.observations[shared],
      parent.observations[shared],
    )
  ) {
    shared += 1;
  }
  return shared;
}

function removeInheritedCodexUsage(
  rollouts: ParsedCodexRollout[],
): ParsedCodexRollout[] {
  const byThreadId = new Map(
    rollouts
      .filter((rollout) => rollout.threadId !== null)
      .map((rollout) => [rollout.threadId!, rollout]),
  );
  return rollouts.map((rollout) => {
    if (!rollout.parentThreadId) return rollout;
    const parent = byThreadId.get(rollout.parentThreadId);
    if (!parent) return rollout;
    const inheritedPrefixLength = inheritedCodexPrefixLength(rollout, parent);
    if (inheritedPrefixLength === 0) return rollout;
    return {
      ...rollout,
      entries: codexUsageEntries(
        rollout.observations,
        rollout.path,
        inheritedPrefixLength,
      ),
    };
  });
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
  sessionsDir?: string;
  scan?: CodexRolloutScan;
}): CodexRolloutCandidate[] {
  const scan =
    input.scan ??
    createCodexRolloutScan(input.sessionsDir ?? defaultCodexSessionsDir());
  if (!input.cwd || scan.files.length === 0) return [];
  return removeInheritedCodexUsage(
    parsedRolloutsByCwd(scan).get(input.cwd) ?? [],
  )
    .map((parsed) => ({
      path: parsed.path,
      size: parsed.size,
      mtimeMs: parsed.mtimeMs,
      startedAtMs: parsed.startedAtMs,
      threadId: parsed.threadId,
      parentThreadId: parsed.parentThreadId,
      entries: parsed.entries,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Locate Grok Build session transcripts for a worktree cwd. Grok does not take
// --session-id and does not store LOOPHUB_SESSION_ID as its session folder name,
// so correlation is by cwd (same approach as Codex rollouts), aggregating every
// Grok session under that worktree.
export function findGrokSessionUpdates(input: {
  cwd: string;
  sessionsDir?: string;
}): GrokSessionCandidate[] {
  const sessionsDir = input.sessionsDir ?? defaultGrokSessionsDir();
  if (!input.cwd || !existsSync(sessionsDir)) return [];
  const cwdDir = join(sessionsDir, encodeGrokSessionCwd(input.cwd));
  if (!existsSync(cwdDir)) return [];

  const out: GrokSessionCandidate[] = [];
  for (const dirent of readdirSync(cwdDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const path = join(cwdDir, dirent.name, "updates.jsonl");
    if (!existsSync(path)) continue;
    const st = statSync(path);
    if (!st.isFile()) continue;
    const turns = parseGrokTurnUsages(readFileSync(path, "utf8"));
    if (turns.length === 0) continue;
    const totals = new Map<string, TokenUsage>();
    for (const turn of turns) {
      for (const [model, usage] of turn.models) {
        totals.set(model, addUsage(totals.get(model) ?? ZERO_USAGE, usage));
      }
    }
    const entries: UsageEntry[] = [...totals.entries()].map(
      ([model, usage]) => ({
        message_id: path,
        model,
        ...usage,
      }),
    );
    out.push({
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sessionId: dirent.name,
      entries,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Locate OpenCode sessions that ran in a worktree cwd. OpenCode does not accept a
// LoopHub session id and writes one shared SQLite DB, so correlation is by the
// session.directory column (same cwd approach as Codex/Grok).
export function findOpencodeSessions(input: {
  cwd: string;
  dbPath?: string;
}): OpencodeSessionCandidate[] {
  const dbPath = input.dbPath ?? defaultOpencodeDbPath();
  if (!input.cwd || !existsSync(dbPath)) return [];

  const directories = opencodeDirectoryCandidates(input.cwd);
  if (directories.length === 0) return [];

  let db: SqliteNS.DatabaseSync;
  try {
    db = new OpencodeDatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }

  try {
    const st = statSync(dbPath);
    const placeholders = directories.map(() => "?").join(", ");
    const sessionRows = db
      .prepare(
        `SELECT id, parent_id, directory, model,
                tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write, time_updated
         FROM session
         WHERE directory IN (${placeholders})`,
      )
      .all(...directories) as unknown as OpencodeSessionRow[];

    const messageStmt = db.prepare(
      `SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id`,
    );

    const out: OpencodeSessionCandidate[] = [];
    for (const row of sessionRows) {
      if (typeof row.id !== "string" || !row.id) continue;
      const messageRows = messageStmt.all(row.id) as unknown as {
        id: string;
        data: string;
      }[];
      const messageEntries = messageRows.flatMap((message) =>
        parseOpencodeMessageUsage(message.id, message.data),
      );
      const entries =
        messageEntries.length > 0
          ? messageEntries
          : sessionLevelOpencodeEntries(row);
      if (entries.length === 0) continue;
      out.push({
        path: `${dbPath}#${row.id}`,
        size: st.size,
        mtimeMs:
          typeof row.time_updated === "number" &&
          Number.isFinite(row.time_updated)
            ? row.time_updated
            : st.mtimeMs,
        sessionId: row.id,
        parentSessionId:
          typeof row.parent_id === "string" && row.parent_id
            ? row.parent_id
            : null,
        directory: typeof row.directory === "string" ? row.directory : "",
        entries,
      });
    }
    return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failures on a read-only handle
    }
  }
}

interface OpencodeSessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  time_updated: number | null;
}

function opencodeDirectoryCandidates(cwd: string): string[] {
  const out = new Set<string>();
  out.add(cwd);
  try {
    if (existsSync(cwd)) out.add(realpathSync(cwd));
  } catch {
    // keep the caller-supplied cwd even when realpath fails
  }
  return [...out].filter(Boolean);
}

function parseOpencodeMessageUsage(
  messageId: string,
  raw: string,
): UsageEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const data = objectValue(parsed);
  if (!data) return [];
  // Only assistant turns carry billed token counters.
  if (stringValue(data.role) !== "assistant") return [];

  const model = opencodeModelName(
    stringValue(data.providerID) ?? stringValue(data.providerId),
    stringValue(data.modelID) ?? stringValue(data.modelId),
    data.model,
  );
  if (!model) return [];

  const tokens = objectValue(data.tokens);
  if (!tokens) return [];
  const cache = objectValue(tokens.cache);
  const usage: TokenUsage = {
    input_tokens: tokenCount(tokens.input),
    cache_creation_input_tokens: tokenCount(cache?.write),
    cache_read_input_tokens: tokenCount(cache?.read),
    // OpenCode tracks reasoning separately; LoopHub has no reasoning bucket, so
    // fold it into output so totals stay visible without inventing a new field.
    output_tokens: tokenCount(tokens.output) + tokenCount(tokens.reasoning),
  };
  if (!hasTokenUsage(usage)) return [];
  return [{ message_id: messageId, model, ...usage }];
}

function sessionLevelOpencodeEntries(row: OpencodeSessionRow): UsageEntry[] {
  const model = opencodeModelFromSessionColumn(row.model);
  if (!model) return [];
  const usage: TokenUsage = {
    input_tokens: tokenCount(row.tokens_input),
    cache_creation_input_tokens: tokenCount(row.tokens_cache_write),
    cache_read_input_tokens: tokenCount(row.tokens_cache_read),
    output_tokens:
      tokenCount(row.tokens_output) + tokenCount(row.tokens_reasoning),
  };
  if (!hasTokenUsage(usage)) return [];
  return [{ message_id: `opencode-session:${row.id}`, model, ...usage }];
}

function opencodeModelFromSessionColumn(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some builds may store a plain "provider/model" string.
    return raw.includes("/") ? raw : null;
  }
  const model = objectValue(parsed);
  if (!model) return typeof parsed === "string" ? parsed : null;
  return opencodeModelName(
    stringValue(model.providerID) ?? stringValue(model.providerId),
    stringValue(model.id) ??
      stringValue(model.modelID) ??
      stringValue(model.modelId),
    null,
  );
}

// Prefer the OpenCode CLI form provider/model so multi-provider sessions stay distinct
// and priceForModel can still match known model id substrings.
function opencodeModelName(
  providerId: string | null,
  modelId: string | null,
  modelField: unknown,
): string | null {
  if (modelId && providerId) return `${providerId}/${modelId}`;
  if (modelId) return modelId;
  const nested = objectValue(modelField);
  if (nested) {
    const nestedProvider =
      stringValue(nested.providerID) ?? stringValue(nested.providerId);
    const nestedModel =
      stringValue(nested.modelID) ??
      stringValue(nested.modelId) ??
      stringValue(nested.id);
    if (nestedModel && nestedProvider)
      return `${nestedProvider}/${nestedModel}`;
    if (nestedModel) return nestedModel;
  }
  return stringValue(modelField);
}
