// Light/dark theme. Class-based per DESIGN.md: toggling the `dark` class on
// <html> switches the token set; components never branch on theme.
//
// The initial class is set by an inline script in index.html (the FOUC guard,
// which mirrors resolveInitialTheme below) before React mounts. This module is
// the runtime source of truth once the app is interactive.

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "lh_theme";

/** Theme persisted by the user, or null if they never chose one. */
export function getStoredTheme(): Theme | null {
  // localStorage access throws in sandboxed iframes / some private modes;
  // treat any failure as "no stored choice" so init never crashes.
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
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

/** Stored choice if any, otherwise the OS preference. */
export function resolveInitialTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

/** Toggle the `dark` class on <html> to match `theme`. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Persist and apply the user's chosen theme. */
export function setTheme(theme: Theme): void {
  // Apply unconditionally so the DOM stays in sync with state even when
  // persistence fails (private mode quota / sandboxed storage).
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; the visual switch below still happens.
  }
  applyTheme(theme);
}
