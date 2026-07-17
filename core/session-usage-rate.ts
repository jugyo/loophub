export interface SessionUsageSample {
  session_id: string;
  total_tokens: number;
  token_delta: number;
  observed_at: string;
}

export interface TokenRateOptions {
  now?: Date;
  windowSeconds?: number;
  maxSampleAgeSeconds?: number;
}

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MAX_SAMPLE_AGE_SECONDS = 90;

function parseTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function totalTokens(usage: {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}): number {
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    usage.output_tokens
  );
}

export function calculateTokensPerSecond(
  samples: SessionUsageSample[],
  opts: TokenRateOptions = {},
): number | null {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  const windowMs = (opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS) * 1000;
  const maxAgeMs =
    (opts.maxSampleAgeSeconds ?? DEFAULT_MAX_SAMPLE_AGE_SECONDS) * 1000;
  const cutoffMs = nowMs - windowMs;

  const bySession = new Map<
    string,
    Array<SessionUsageSample & { observedMs: number }>
  >();
  for (const sample of samples) {
    const observedMs = parseTime(sample.observed_at);
    if (observedMs == null) continue;
    if (observedMs < cutoffMs || observedMs > nowMs) continue;
    if (nowMs - observedMs > maxAgeMs) continue;
    if (sample.total_tokens < 0) continue;
    const rows = bySession.get(sample.session_id) ?? [];
    rows.push({ ...sample, observedMs });
    bySession.set(sample.session_id, rows);
  }

  let tokensPerSecond = 0;
  let sessionsWithRate = 0;
  for (const rows of bySession.values()) {
    rows.sort((a, b) => a.observedMs - b.observedMs);
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last || first === last) continue;
    const sessionElapsed = (last.observedMs - first.observedMs) / 1000;
    if (sessionElapsed <= 0) continue;
    const sessionDelta = rows
      .slice(1)
      .reduce((sum, row) => sum + Math.max(0, row.token_delta), 0);
    tokensPerSecond += sessionDelta / sessionElapsed;
    sessionsWithRate += 1;
  }

  if (sessionsWithRate === 0) return null;
  return tokensPerSecond;
}

export interface GrokTurnRateTurn {
  totalTokens: number;
  apiDurationMs: number | null;
}

export interface PlannedUsageSample {
  totalTokens: number;
  tokenDelta: number;
  observedAt: string;
}

// Sum apiDurationMs for the portion of turns that pushed the cumulative total
// past `previousTotal`. Partial credit when a single turn straddles the cursor
// (same prompt_id updated with higher usage).
export function newGrokWorkDurationMs(
  turns: ReadonlyArray<GrokTurnRateTurn>,
  previousTotal: number,
): number | null {
  let cum = 0;
  let durationMs = 0;
  let any = false;
  for (const turn of turns) {
    const turnTokens = Math.max(0, turn.totalTokens);
    if (turnTokens <= 0) continue;
    const prevCum = cum;
    cum += turnTokens;
    if (cum <= previousTotal) continue;
    if (turn.apiDurationMs == null || turn.apiDurationMs <= 0) continue;
    if (prevCum >= previousTotal) {
      durationMs += turn.apiDurationMs;
      any = true;
      continue;
    }
    const newInTurn = cum - previousTotal;
    durationMs += turn.apiDurationMs * (newInTurn / turnTokens);
    any = true;
  }
  return any ? durationMs : null;
}

// Grok only reports billed usage on turn_completed. A single sample at the
// jump would store token_delta=0 on the first observation (no previous sample),
// so live TPS stays 0. Reconstruct the turn's average rate as a two-point
// sample pair: place an anchor at (now - span) and a positive-delta sample at
// now. When the turn is longer than the live 60s window, cap span and scale
// token_delta so calculateTokensPerSecond ≈ newTokens / (apiDurationMs/1000).
export function planGrokTurnRateSamples(input: {
  previousTotal: number;
  newTotal: number;
  turns: ReadonlyArray<GrokTurnRateTurn>;
  now?: Date;
  /** Keep the pair inside liveTokensPerSecond's default 60s window. */
  maxSpanSeconds?: number;
}): PlannedUsageSample[] | null {
  const previousTotal = Math.max(0, input.previousTotal);
  const newTotal = Math.max(0, input.newTotal);
  const delta = newTotal - previousTotal;
  if (!(delta > 0)) return null;

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;

  const maxSpanSeconds = input.maxSpanSeconds ?? 55;
  const durationMs = newGrokWorkDurationMs(input.turns, previousTotal);
  const durationSec =
    durationMs != null && durationMs > 0 ? durationMs / 1000 : null;
  // Fallback when apiDurationMs is missing: 1s span with the full delta so the
  // first turn still produces a two-sample rate instead of a lone delta-0 row.
  const spanSec = Math.min(
    Math.max(durationSec ?? 1, 1e-3),
    Math.max(maxSpanSeconds, 1e-3),
  );
  const scaledDelta =
    durationSec != null && durationSec > 0
      ? delta * (spanSec / durationSec)
      : delta;

  const anchorAt = new Date(nowMs - spanSec * 1000).toISOString();
  const endAt = now.toISOString();
  return [
    {
      totalTokens: previousTotal,
      tokenDelta: 0,
      observedAt: anchorAt,
    },
    {
      totalTokens: newTotal,
      tokenDelta: scaledDelta,
      observedAt: endAt,
    },
  ];
}
