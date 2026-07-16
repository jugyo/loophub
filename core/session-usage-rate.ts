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
