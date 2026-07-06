import { describe, expect, it } from "vitest";
import { formatTokenCountShort } from "./session-usage";

describe("formatTokenCountShort", () => {
  it("shows sub-thousand counts verbatim", () => {
    expect(formatTokenCountShort(0)).toBe("0");
    expect(formatTokenCountShort(999)).toBe("999");
  });

  it("abbreviates thousands with one decimal", () => {
    expect(formatTokenCountShort(1000)).toBe("1k");
    expect(formatTokenCountShort(1234)).toBe("1.2k");
    expect(formatTokenCountShort(12345)).toBe("12.3k");
  });

  it("drops the decimal once the value reaches three digits", () => {
    expect(formatTokenCountShort(123456)).toBe("123k");
  });

  it("abbreviates millions and billions", () => {
    expect(formatTokenCountShort(3_400_000)).toBe("3.4M");
    expect(formatTokenCountShort(2_000_000_000)).toBe("2B");
  });

  it("carries a rounded-up bucket over to the next unit instead of showing 4 digits", () => {
    // 999_500 / 1000 rounds to 1000, which belongs to the M bucket, not "1000k".
    expect(formatTokenCountShort(999_500)).toBe("1M");
    expect(formatTokenCountShort(999_500_000)).toBe("1B");
  });
});
