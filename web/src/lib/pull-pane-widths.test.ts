import { afterEach, describe, expect, it, vi } from "#loophub-test";
import {
  clampPullPaneWidth,
  getPullPaneWidth,
  setPullPaneWidth,
} from "./pull-pane-widths";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("pull pane widths", () => {
  it("has no width until one is stored", () => {
    expect(getPullPaneWidth("diff")).toBeNull();
    expect(getPullPaneWidth("other")).toBeNull();
  });

  it("stores the Diff view and the other views independently", () => {
    setPullPaneWidth("diff", 900);
    expect(getPullPaneWidth("diff")).toBe(900);
    expect(getPullPaneWidth("other")).toBeNull();

    setPullPaneWidth("other", 500);
    expect(getPullPaneWidth("diff")).toBe(900);
    expect(getPullPaneWidth("other")).toBe(500);
  });

  it("ignores unrecognized stored values", () => {
    for (const value of ["wide", "-100", "0", "Infinity"]) {
      localStorage.setItem("lh_pull_pane_width", value);
      expect(getPullPaneWidth("other")).toBeNull();
    }
  });

  it("falls back to no width when storage cannot be read or written", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });

    expect(() => setPullPaneWidth("diff", 900)).not.toThrow();
    expect(getPullPaneWidth("diff")).toBeNull();
  });

  it("keeps room for both columns and the rail", () => {
    expect(clampPullPaneWidth(600, 1400)).toBe(600);
    expect(clampPullPaneWidth(100, 1400)).toBe(320);
    expect(clampPullPaneWidth(1390, 1400)).toBe(1032);
  });
});
