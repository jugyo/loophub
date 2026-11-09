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

describe("pull left column widths", () => {
  it("has no width until one is stored", () => {
    expect(getPullLeftColumnWidth("diff")).toBeNull();
    expect(getPullLeftColumnWidth("other")).toBeNull();
  });

  it("stores the Diff view and the other views independently", () => {
    setPullLeftColumnWidth("diff", 900);
    expect(getPullLeftColumnWidth("diff")).toBe(900);
    expect(getPullLeftColumnWidth("other")).toBeNull();

    setPullLeftColumnWidth("other", 500);
    expect(getPullLeftColumnWidth("diff")).toBe(900);
    expect(getPullLeftColumnWidth("other")).toBe(500);
  });

  it("ignores unrecognized stored values", () => {
    for (const value of ["wide", "-100", "0", "Infinity"]) {
      localStorage.setItem("lh_pull_left_column_width", value);
      expect(getPullLeftColumnWidth("other")).toBeNull();
    }
  });

  it("falls back to no width when storage cannot be read or written", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });

    expect(() => setPullLeftColumnWidth("diff", 900)).not.toThrow();
    expect(getPullLeftColumnWidth("diff")).toBeNull();
  });

  it("keeps room for both columns and the rail", () => {
    expect(clampPullLeftColumnWidth(600, 1400)).toBe(600);
    expect(clampPullLeftColumnWidth(100, 1400)).toBe(320);
    expect(clampPullLeftColumnWidth(1390, 1400)).toBe(1032);
  });
});
