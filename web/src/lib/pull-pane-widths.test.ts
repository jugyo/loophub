import { afterEach, describe, expect, it, vi } from "#loophub-test";
import {
  clampPullLeftColumnWidth,
  getPullLeftColumnWidth,
  setPullLeftColumnWidth,
} from "./pull-pane-widths";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("pull left column width", () => {
  it("has no width until one is stored", () => {
    expect(getPullLeftColumnWidth()).toBeNull();
  });

  it("returns the stored width", () => {
    setPullLeftColumnWidth(900);
    expect(getPullLeftColumnWidth()).toBe(900);
  });

  it("ignores unrecognized stored values", () => {
    for (const value of ["wide", "-100", "0", "Infinity"]) {
      localStorage.setItem("lh_pull_left_column_width", value);
      expect(getPullLeftColumnWidth()).toBeNull();
    }
  });

  it("falls back to no width when storage cannot be read or written", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });

    expect(() => setPullLeftColumnWidth(900)).not.toThrow();
    expect(getPullLeftColumnWidth()).toBeNull();
  });

  it("keeps room for both columns and the rail", () => {
    expect(clampPullLeftColumnWidth(600, 1400)).toBe(600);
    expect(clampPullLeftColumnWidth(100, 1400)).toBe(320);
    expect(clampPullLeftColumnWidth(1390, 1400)).toBe(1032);
  });
});
