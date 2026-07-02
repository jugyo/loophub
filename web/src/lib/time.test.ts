import { describe, expect, it } from "vitest";
import { formatDuration } from "./time";

describe("formatDuration", () => {
  it("shows the two largest non-zero units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatDuration(90000)).toBe("1d 1h");
  });

  it("drops a zero secondary unit instead of padding with 0s/0m", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(60)).toBe("1m");
  });

  it("rounds to the nearest second and floors negative/non-finite input", () => {
    expect(formatDuration(59.6)).toBe("1m");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
  });
});
