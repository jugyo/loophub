export const TOKEN_RATE_BUCKET_COUNT = 36;
export const TOKEN_RATE_BUCKET_MS = 5 * 60 * 1000;

export interface TokenRateHistorySample {
  tokens_per_second: number;
  observed_at: string;
}

/**
 * Build the topbar's three-hour history as aligned five-minute buckets.
 * Missing buckets are zero; the live rate is included in the current bucket.
 */
export function tokensPerFiveMinuteHistory(
  samples: TokenRateHistorySample[],
  options: { now: Date; liveTokensPerSecond: number | null },
): number[] {
  const currentBucketStart =
    Math.floor(options.now.getTime() / TOKEN_RATE_BUCKET_MS) *
    TOKEN_RATE_BUCKET_MS;
  const firstBucketStart =
    currentBucketStart - (TOKEN_RATE_BUCKET_COUNT - 1) * TOKEN_RATE_BUCKET_MS;
  const totals = Array<number>(TOKEN_RATE_BUCKET_COUNT).fill(0);
  const counts = Array<number>(TOKEN_RATE_BUCKET_COUNT).fill(0);

  const addSample = (tokensPerSecond: number, observedAt: number) => {
    if (
      !Number.isFinite(tokensPerSecond) ||
      tokensPerSecond < 0 ||
      !Number.isFinite(observedAt)
    ) {
      return;
    }
    const bucket = Math.floor(
      (observedAt - firstBucketStart) / TOKEN_RATE_BUCKET_MS,
    );
    if (bucket < 0 || bucket >= TOKEN_RATE_BUCKET_COUNT) return;
    totals[bucket] += tokensPerSecond;
    counts[bucket] += 1;
  };

  for (const sample of samples) {
    addSample(sample.tokens_per_second, Date.parse(sample.observed_at));
  }
  if (options.liveTokensPerSecond != null) {
    addSample(options.liveTokensPerSecond, options.now.getTime());
  }

  return totals.map((total, index) =>
    counts[index] === 0 ? 0 : (total / counts[index]) * 5 * 60,
  );
}
