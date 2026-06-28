import { describe, expect, it } from "vitest";
import {
  LABEL_COLOR_PALETTE,
  labelColorClass,
  labelColorIndex,
} from "./label-color";

describe("label-color", () => {
  it("has a palette of 64 entries", () => {
    expect(LABEL_COLOR_PALETTE).toHaveLength(64);
  });

  it("every palette entry carries light and dark colour classes", () => {
    for (const cls of LABEL_COLOR_PALETTE) {
      expect(cls).toMatch(/\bbg-/);
      expect(cls).toMatch(/\btext-/);
      expect(cls).toMatch(/\bdark:bg-/);
      expect(cls).toMatch(/\bdark:text-/);
    }
  });

  it("is deterministic: same name → same index/class", () => {
    expect(labelColorIndex("bug")).toBe(labelColorIndex("bug"));
    expect(labelColorClass("ready-to-build")).toBe(
      labelColorClass("ready-to-build"),
    );
  });

  it("returns an in-range index for any name", () => {
    for (const name of ["", "a", "bug", "ready-to-build", "型/設計", "🚀"]) {
      const i = labelColorIndex(name);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(LABEL_COLOR_PALETTE.length);
    }
  });

  it("maps the index to the matching palette entry", () => {
    const name = "enhancement";
    expect(labelColorClass(name)).toBe(
      LABEL_COLOR_PALETTE[labelColorIndex(name)],
    );
  });

  it("spreads names across the palette without heavy bias", () => {
    // Generate many distinct names and check the hash fills most buckets fairly
    // evenly — a guard against a degenerate hash that clusters labels.
    // Word-shaped names rather than a shared "label-N" prefix, so the test
    // reflects realistic label inputs (djb2 correlates on long common prefixes).
    const prefixes = ["bug", "feat", "chore", "area", "prio", "type", "size"];
    const counts = new Array(LABEL_COLOR_PALETTE.length).fill(0);
    let n = 0;
    for (const p of prefixes) {
      for (let i = 0; i < 1000; i++) {
        counts[labelColorIndex(`${p}/${i.toString(36)}`)]++;
        n++;
      }
    }
    const used = counts.filter((c) => c > 0).length;
    expect(used).toBe(LABEL_COLOR_PALETTE.length); // every bucket hit

    const expected = n / LABEL_COLOR_PALETTE.length;
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    // No bucket should be wildly over/under-represented (a degenerate hash would
    // leave buckets empty above, or blow past these bounds here).
    expect(max).toBeLessThan(expected * 2);
    expect(min).toBeGreaterThan(expected * 0.4);
  });
});
