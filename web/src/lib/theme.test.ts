import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  getStoredTheme,
  resolveInitialTheme,
  setTheme,
  THEME_STORAGE_KEY,
} from "./theme";

function mockSystemTheme(prefersLight: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("light") ? prefersLight : !prefersLight,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getStoredTheme", () => {
  it("returns null when nothing is stored", () => {
    expect(getStoredTheme()).toBeNull();
  });

  it("returns the stored value when valid", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(getStoredTheme()).toBe("light");
  });

  it("ignores invalid stored values", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(getStoredTheme()).toBeNull();
  });

  it("returns null when localStorage access throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(getStoredTheme()).toBeNull();
  });
});

describe("resolveInitialTheme", () => {
  it("prefers the stored choice over the OS preference", () => {
    mockSystemTheme(true);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(resolveInitialTheme()).toBe("dark");
  });

  it("falls back to the OS preference when unset", () => {
    mockSystemTheme(true);
    expect(resolveInitialTheme()).toBe("light");
  });

  it("defaults to dark when the OS prefers dark", () => {
    mockSystemTheme(false);
    expect(resolveInitialTheme()).toBe("dark");
  });

  it("defaults to dark when matchMedia throws", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("not supported");
    });
    expect(resolveInitialTheme()).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("adds the dark class for dark", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes the dark class for light", () => {
    document.documentElement.classList.add("dark");
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("setTheme", () => {
  it("persists and applies the theme", () => {
    setTheme("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    setTheme("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("still applies the theme when persistence throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    document.documentElement.classList.add("dark");
    expect(() => setTheme("light")).not.toThrow();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
