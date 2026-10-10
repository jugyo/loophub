import { afterEach, describe, expect, it, vi } from "#loophub-test";
import {
  getDiffViewMode,
  getMarkdownDiffMode,
  getStandardDiffMode,
  setDiffViewMode,
  setMarkdownDiffMode,
  setStandardDiffMode,
} from "./diff-view-preferences";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("diff view preferences", () => {
  it("defaults to diff and unified when nothing is stored", () => {
    expect(getMarkdownDiffMode()).toBe("diff");
    expect(getStandardDiffMode()).toBe("diff");
    expect(getDiffViewMode()).toBe("unified");
  });

  it("stores each mode independently", () => {
    setMarkdownDiffMode("rendered");
    setStandardDiffMode("raw");
    setDiffViewMode("split");

    expect(getMarkdownDiffMode()).toBe("rendered");
    expect(getStandardDiffMode()).toBe("raw");
    expect(getDiffViewMode()).toBe("split");
  });

  it("ignores unrecognized stored values", () => {
    localStorage.setItem("lh_diff_markdown_mode", "preview");
    localStorage.setItem("lh_diff_standard_mode", "rendered");
    localStorage.setItem("lh_diff_view_mode", "side-by-side");

    expect(getMarkdownDiffMode()).toBe("diff");
    expect(getStandardDiffMode()).toBe("diff");
    expect(getDiffViewMode()).toBe("unified");
  });

  it("falls back to the defaults when storage cannot be read or written", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });

    expect(() => setMarkdownDiffMode("rendered")).not.toThrow();
    expect(() => setStandardDiffMode("raw")).not.toThrow();
    expect(() => setDiffViewMode("split")).not.toThrow();
    expect(getMarkdownDiffMode()).toBe("diff");
    expect(getStandardDiffMode()).toBe("diff");
    expect(getDiffViewMode()).toBe("unified");
  });
});
