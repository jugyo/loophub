import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  getStoredTheme,
  resolveInitialTheme,
  setTheme,
  THEME_STORAGE_KEY,
} from "./theme";

type Hsl = [number, number, number];
type Rgb = [number, number, number];

function parseThemeTokens(selector: ":root" | ".dark"): Record<string, string> {
  const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
  const match = css.match(
    new RegExp(`${selector.replace(".", "\\.")} \\{([\\s\\S]*?)\\n  \\}`),
  );
  if (!match) throw new Error(`Missing ${selector} theme tokens`);

  return Object.fromEntries(
    [...match[1].matchAll(/--([a-z-]+):\s*([^;]+);/g)].map(([, key, value]) => [
      key,
      value.trim(),
    ]),
  );
}

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

describe("theme contrast tokens", () => {
  it("keeps dark primary button states readable", () => {
    const dark = parseThemeTokens(".dark");

    expectContrast(dark, "primary-foreground", "primary", 4.5);
    expectContrast(dark, "primary-foreground", "primary-hover", 4.5);
    expectContrast(dark, "primary-foreground", "primary-active", 4.5);
    expectContrast(dark, "accent-foreground", "primary-subtle", 4.5);
  });

  it("keeps dark supporting text and boundaries visible", () => {
    const dark = parseThemeTokens(".dark");

    expectContrast(dark, "foreground", "background", 7);
    expectContrast(dark, "muted-foreground", "background", 4.5);
    expectContrast(dark, "muted-foreground", "muted", 4.5);
    expectContrast(dark, "secondary-foreground", "secondary", 4.5);
    expectContrast(dark, "accent-foreground", "accent", 4.5);
    expectContrast(dark, "border", "background", 1.75);
  });
});
