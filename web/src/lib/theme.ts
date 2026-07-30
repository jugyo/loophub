// Web UI themes. This file is the runtime source of truth for theme IDs,
// labels, light/dark appearance, and CSS variable values.
//
// The initial light/dark class is set from the OS preference by an inline
// script in index.html before React mounts. The server-persisted selection is
// applied before the app renders.

import type { Theme as ThemeId } from "@/api/types";

type ThemeAppearance = "light" | "dark";

export const THEME_TOKEN_KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-hover",
  "primary-active",
  "primary-subtle",
  "primary-border",
  "primary-foreground",
  "link",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeTokens = Record<ThemeTokenKey, string>;

type ThemeDefinitionInput = {
  id: ThemeId;
  label: string;
  description: string;
  appearance: ThemeAppearance;
  tokens: ThemeTokens;
};

type ThemeDefinitions = {
  [Id in ThemeId]: ThemeDefinitionInput & { id: Id };
};

const THEME_DEFINITIONS = {
  light: {
    id: "light",
    label: "LoopHub (Light)",
    description: "Bright neutral workspace",
    appearance: "light",
    tokens: {
      background: "0 0% 100%",
      foreground: "222.2 84% 4.9%",
      card: "0 0% 100%",
      "card-foreground": "222.2 84% 4.9%",
      primary: "244 57% 50%",
      "primary-hover": "243 58% 42%",
      "primary-active": "243 67% 35%",
      "primary-subtle": "226 100% 97%",
      "primary-border": "229 96% 85%",
      "primary-foreground": "0 0% 100%",
      link: "244 57% 50%",
      secondary: "210 40% 96.1%",
      "secondary-foreground": "222.2 47.4% 11.2%",
      muted: "210 40% 96.1%",
      "muted-foreground": "215.4 16.3% 46.9%",
      accent: "var(--primary-subtle)",
      "accent-foreground": "243 58% 28%",
      destructive: "0 84.2% 60.2%",
      "destructive-foreground": "210 40% 98%",
      border: "214.3 31.8% 91.4%",
      input: "214.3 31.8% 91.4%",
      ring: "var(--primary)",
    },
  },
  dark: {
    id: "dark",
    label: "LoopHub (Dark)",
    description: "Low-light neutral workspace",
    appearance: "dark",
    tokens: {
      background: "222.2 84% 4.9%",
      foreground: "210 40% 98%",
      card: "222.2 84% 4.9%",
      "card-foreground": "210 40% 98%",
      primary: "238 84% 69%",
      "primary-hover": "229 96% 77%",
      "primary-active": "239 84% 67%",
      "primary-subtle": "242 47% 16%",
      "primary-border": "239 84% 67%",
      "primary-foreground": "222.2 84% 4.9%",
      link: "229 96% 77%",
      secondary: "217.2 32.6% 17.5%",
      "secondary-foreground": "210 40% 98%",
      muted: "217.2 32.6% 17.5%",
      "muted-foreground": "215 20.2% 65.1%",
      accent: "var(--primary-subtle)",
      "accent-foreground": "226 100% 94%",
      destructive: "0 62.8% 30.6%",
      "destructive-foreground": "210 40% 98%",
      border: "217 28% 25%",
      input: "217 28% 25%",
      ring: "var(--primary)",
    },
  },
  solarized: {
    id: "solarized",
    label: "Solarized Light",
    description: "Warm paper with teal accents",
    appearance: "light",
    tokens: {
      background: "44 87% 94%",
      foreground: "192 100% 11%",
      card: "44 87% 96%",
      "card-foreground": "192 100% 11%",
      primary: "192 100% 28%",
      "primary-hover": "193 100% 23%",
      "primary-active": "194 100% 18%",
      "primary-subtle": "180 44% 88%",
      "primary-border": "184 34% 68%",
      "primary-foreground": "44 87% 96%",
      link: "192 100% 28%",
      secondary: "45 54% 88%",
      "secondary-foreground": "192 100% 16%",
      muted: "45 54% 88%",
      "muted-foreground": "194 14% 40%",
      accent: "var(--primary-subtle)",
      "accent-foreground": "192 100% 16%",
      destructive: "1 71% 52%",
      "destructive-foreground": "44 87% 96%",
      border: "43 28% 76%",
      input: "43 28% 76%",
      ring: "var(--primary)",
    },
  },
  "solarized-dark": {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Ink-blue workspace with amber accents",
    appearance: "dark",
    tokens: {
      background: "192 100% 11%",
      foreground: "44 87% 94%",
      card: "192 82% 14%",
      "card-foreground": "44 87% 94%",
      primary: "39 100% 46%",
      "primary-hover": "35 100% 52%",
      "primary-active": "41 100% 40%",
      "primary-subtle": "192 59% 20%",
      "primary-border": "39 79% 42%",
      "primary-foreground": "192 100% 11%",
      link: "35 100% 56%",
      secondary: "192 57% 18%",
      "secondary-foreground": "44 87% 94%",
      muted: "192 57% 18%",
      "muted-foreground": "45 21% 71%",
      accent: "var(--primary-subtle)",
      "accent-foreground": "44 87% 94%",
      destructive: "1 71% 52%",
      "destructive-foreground": "44 87% 96%",
      border: "192 45% 24%",
      input: "192 45% 24%",
      ring: "var(--primary)",
    },
  },
  midnight: {
    id: "midnight",
    label: "Midnight",
    description: "Deep blue with cyan accents",
    appearance: "dark",
    tokens: {
      background: "222 47% 8%",
      foreground: "210 40% 96%",
      card: "222 44% 10%",
      "card-foreground": "210 40% 96%",
      primary: "188 94% 43%",
      "primary-hover": "187 91% 50%",
      "primary-active": "188 97% 38%",
      "primary-subtle": "210 52% 16%",
      "primary-border": "188 80% 37%",
      "primary-foreground": "222 47% 8%",
      link: "187 91% 50%",
      secondary: "220 36% 14%",
      "secondary-foreground": "210 40% 96%",
      muted: "220 36% 14%",
      "muted-foreground": "211 24% 69%",
      accent: "var(--primary-subtle)",
      "accent-foreground": "188 100% 88%",
      destructive: "0 62.8% 30.6%",
      "destructive-foreground": "210 40% 98%",
      border: "218 28% 24%",
      input: "218 28% 24%",
      ring: "var(--primary)",
    },
  },
  graphite: {
    id: "graphite",
    label: "Graphite",
    description: "Soft charcoal with violet accents",
    appearance: "dark",
    tokens: {
      background: "240 7% 9%",
      foreground: "240 8% 94%",
      card: "240 6% 12%",
      "card-foreground": "240 8% 94%",
      primary: "263 70% 67%",
      "primary-hover": "263 78% 73%",
      "primary-active": "263 60% 58%",
      "primary-subtle": "246 18% 19%",
      "primary-border": "263 45% 50%",
      "primary-foreground": "240 7% 9%",
      link: "263 78% 73%",
      secondary: "240 5% 17%",
      "secondary-foreground": "240 8% 94%",
      muted: "240 5% 17%",
      "muted-foreground": "240 7% 69%",
      accent: "var(--primary-subtle)",
      "accent-foreground": "263 100% 91%",
      destructive: "0 62.8% 30.6%",
      "destructive-foreground": "210 40% 98%",
      border: "240 5% 25%",
      input: "240 5% 25%",
      ring: "var(--primary)",
    },
  },
  forest: {
    id: "forest",
    label: "Forest",
    description: "Fresh green workspace",
    appearance: "light",
    tokens: {
      background: "90 30% 96%",
      foreground: "154 44% 12%",
      card: "96 33% 98%",
      "card-foreground": "154 44% 12%",
      primary: "151 56% 31%",
      "primary-hover": "151 61% 25%",
      "primary-active": "151 65% 20%",
      "primary-subtle": "96 44% 88%",
      "primary-border": "143 29% 68%",
      "primary-foreground": "96 33% 98%",
      link: "151 56% 31%",
      secondary: "96 28% 90%",
      "secondary-foreground": "154 44% 14%",
      muted: "96 28% 90%",
      "muted-foreground": "151 12% 40%",
      accent: "var(--primary-subtle)",
      "accent-foreground": "151 56% 19%",
      destructive: "0 70% 48%",
      "destructive-foreground": "96 33% 98%",
      border: "96 20% 77%",
      input: "96 20% 77%",
      ring: "var(--primary)",
    },
  },
  rose: {
    id: "rose",
    label: "Rose",
    description: "Warm rose workspace",
    appearance: "light",
    tokens: {
      background: "18 100% 97%",
      foreground: "337 48% 15%",
      card: "18 100% 98%",
      "card-foreground": "337 48% 15%",
      primary: "342 62% 44%",
      "primary-hover": "342 68% 37%",
      "primary-active": "342 74% 31%",
      "primary-subtle": "350 79% 92%",
      "primary-border": "346 56% 76%",
      "primary-foreground": "18 100% 98%",
      link: "342 62% 44%",
      secondary: "18 53% 92%",
      "secondary-foreground": "337 48% 17%",
      muted: "18 53% 92%",
      "muted-foreground": "343 13% 43%",
      accent: "var(--primary-subtle)",
      "accent-foreground": "342 62% 29%",
      destructive: "0 70% 48%",
      "destructive-foreground": "18 100% 98%",
      border: "18 31% 82%",
      input: "18 31% 82%",
      ring: "var(--primary)",
    },
  },
} as const satisfies ThemeDefinitions;

export const THEMES = Object.values(THEME_DEFINITIONS);

export type Theme = ThemeId;
export type ThemeDefinition = (typeof THEMES)[number];

const THEME_CLASS_PREFIX = "theme-";

export function getThemeDefinition(theme: Theme): ThemeDefinition {
  return THEMES.find((candidate) => candidate.id === theme) ?? THEMES[0];
}

/** The OS preference, defaulting to dark when it can't be read. */
export function getSystemTheme(): Theme {
  // matchMedia can be missing/throwing in sandboxed contexts; mirror the FOUC
  // guard's dark fallback so resolveInitialTheme never crashes init.
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

/** Server choice if any, otherwise the OS preference. */
export function resolveInitialTheme(theme?: Theme | null): Theme {
  return theme ?? getSystemTheme();
}

/** Apply the selected theme's root classes, data attribute, and CSS variables. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const definition = getThemeDefinition(theme);

  for (const candidate of THEMES) {
    root.classList.remove(`${THEME_CLASS_PREFIX}${candidate.id}`);
  }
  root.classList.add(`${THEME_CLASS_PREFIX}${theme}`);
  root.classList.toggle("dark", definition.appearance === "dark");
  root.dataset.theme = theme;

  for (const key of THEME_TOKEN_KEYS) {
    root.style.setProperty(`--${key}`, definition.tokens[key]);
  }
}
