import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  getStoredTheme,
  getThemeDefinition,
  resolveInitialTheme,
  setTheme,
  subscribeStoredTheme,
  THEME_APPEARANCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_TOKEN_KEYS,
  THEMES,
} from "./theme";

type Hsl = [number, number, number];
type Rgb = [number, number, number];

function resolveToken(tokens: Record<string, string>, key: string): string {
  const value = tokens[key];
  if (!value) throw new Error(`Missing theme token: ${key}`);

  const ref = value.match(/^var\(--([a-z-]+)\)$/);
  return ref ? resolveToken(tokens, ref[1]) : value;
}

function hslToken(tokens: Record<string, string>, key: string): Hsl {
  const parts = resolveToken(tokens, key)
    .match(/^([0-9.]+) ([0-9.]+)% ([0-9.]+)%$/)
    ?.slice(1)
    .map(Number);
  if (!parts) throw new Error(`Invalid HSL token: ${key}`);
  return parts as Hsl;
}

function hslToRgb([h, sPercent, lPercent]: Hsl): Rgb {
  const s = sPercent / 100;
  const l = lPercent / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return [r + m, g + m, b + m];
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  ) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Hsl, b: Hsl): number {
  const l1 = relativeLuminance(hslToRgb(a));
  const l2 = relativeLuminance(hslToRgb(b));
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrast(
  tokens: Record<string, string>,
  foreground: string,
  background: string,
  minimum: number,
) {
  expect(
    contrastRatio(hslToken(tokens, foreground), hslToken(tokens, background)),
    `${foreground} on ${background}`,
  ).toBeGreaterThanOrEqual(minimum);
}

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
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("THEMES", () => {
  it("offers eight built-in themes with LoopHub labels for the defaults", () => {
    expect(THEMES).toHaveLength(8);
    expect(getThemeDefinition("light").label).toBe("LoopHub (Light)");
    expect(getThemeDefinition("dark").label).toBe("LoopHub (Dark)");
  });
});

describe("getStoredTheme", () => {
  it("returns null when nothing is stored", () => {
    expect(getStoredTheme()).toBeNull();
  });

  it("returns the stored value when valid", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(getStoredTheme()).toBe("light");
  });

  it("returns newly added theme ids when valid", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "forest");
    expect(getStoredTheme()).toBe("forest");
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
    expect(document.documentElement.classList.contains("theme-dark")).toBe(
      true,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("removes the dark class for light", () => {
    document.documentElement.classList.add("dark");
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("theme-light")).toBe(
      true,
    );
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applies one theme class at a time", () => {
    applyTheme("midnight");
    applyTheme("solarized");

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("theme-solarized")).toBe(
      true,
    );
    expect(document.documentElement.classList.contains("theme-midnight")).toBe(
      false,
    );
    expect(document.documentElement.dataset.theme).toBe("solarized");
  });

  it("applies the selected theme tokens as inline css variables", () => {
    applyTheme("forest");
    const tokens = getThemeDefinition("forest").tokens;

    expect(
      document.documentElement.style.getPropertyValue("--background"),
    ).toBe(tokens.background);
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      tokens.primary,
    );
  });
});

describe("setTheme", () => {
  it("persists and applies the theme", () => {
    setTheme("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(localStorage.getItem(THEME_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    setTheme("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(localStorage.getItem(THEME_APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("persists and applies a non-default theme", () => {
    setTheme("midnight");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("midnight");
    expect(localStorage.getItem(THEME_APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-midnight")).toBe(
      true,
    );
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

describe("subscribeStoredTheme", () => {
  function emitStorage(key: string | null, newValue: string | null) {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  }

  it("reports theme changes made by another tab", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeStoredTheme(onChange);

    emitStorage(THEME_STORAGE_KEY, "midnight");
    expect(onChange).toHaveBeenCalledWith("midnight");

    unsubscribe();
  });

  it("ignores other keys and invalid values", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeStoredTheme(onChange);

    emitStorage(THEME_APPEARANCE_STORAGE_KEY, "dark");
    emitStorage(THEME_STORAGE_KEY, "neon");
    emitStorage(null, null);
    expect(onChange).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("stops reporting once unsubscribed", () => {
    const onChange = vi.fn();
    subscribeStoredTheme(onChange)();

    emitStorage(THEME_STORAGE_KEY, "forest");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("theme contrast tokens", () => {
  it("defines a complete runtime token set for every theme", () => {
    for (const theme of THEMES) {
      expect(Object.keys(theme.tokens).sort()).toEqual(
        [...THEME_TOKEN_KEYS].sort(),
      );
    }
  });

  it("keeps dark primary button states readable", () => {
    const dark = getThemeDefinition("dark").tokens;

    expectContrast(dark, "primary-foreground", "primary", 4.5);
    expectContrast(dark, "primary-foreground", "primary-hover", 4.5);
    expectContrast(dark, "primary-foreground", "primary-active", 4.5);
    expectContrast(dark, "accent-foreground", "primary-subtle", 4.5);
  });

  it("keeps dark supporting text and boundaries visible", () => {
    const dark = getThemeDefinition("dark").tokens;

    expectContrast(dark, "foreground", "background", 7);
    expectContrast(dark, "muted-foreground", "background", 4.5);
    expectContrast(dark, "muted-foreground", "muted", 4.5);
    expectContrast(dark, "secondary-foreground", "secondary", 4.5);
    expectContrast(dark, "accent-foreground", "accent", 4.5);
    expectContrast(dark, "border", "background", 1.75);
  });
});
