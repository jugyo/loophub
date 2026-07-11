import { describe, expect, it } from "vitest";
import {
  TOKEN_RATE_BUCKET_COUNT,
  tokensPerFiveMinuteHistory,
} from "./session-rate-history.ts";

describe("tokensPerFiveMinuteHistory", () => {
  it("returns 24 aligned buckets for two hours in oldest-to-newest order and fills gaps with zero", () => {
    const history = tokensPerFiveMinuteHistory(
      [
        { tokens_per_second: 2, observed_at: "2026-07-11T09:02:00Z" },
        { tokens_per_second: 4, observed_at: "2026-07-11T09:04:00Z" },
        { tokens_per_second: 8, observed_at: "2026-07-11T09:06:00Z" },
      ],
      {
        now: new Date("2026-07-11T09:07:30Z"),
        liveTokensPerSecond: 10,
      },
    );

    expect(history).toHaveLength(TOKEN_RATE_BUCKET_COUNT);
    expect(history.slice(-3)).toEqual([0, 900, 2700]);
  });

  it("ignores out-of-range and invalid samples", () => {
    const history = tokensPerFiveMinuteHistory(
      [
        { tokens_per_second: 12, observed_at: "2026-07-11T06:04:59Z" },
        { tokens_per_second: -1, observed_at: "2026-07-11T09:06:00Z" },
        { tokens_per_second: Number.NaN, observed_at: "2026-07-11T09:06:00Z" },
        { tokens_per_second: 3, observed_at: "invalid" },
      ],
      {
        now: new Date("2026-07-11T09:07:30Z"),
        liveTokensPerSecond: null,
      },
    );

    expect(history).toEqual(Array(TOKEN_RATE_BUCKET_COUNT).fill(0));
  });
});
