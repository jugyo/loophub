// React binding for the theme module. Theme classes are already on <html>
// (set by the inline FOUC guard); this hook tracks and updates the selection.

import { useCallback, useState } from "react";
import {
  getThemeDefinition,
  setTheme as persistTheme,
  resolveInitialTheme,
  type Theme,
} from "@/lib/theme";

export function useTheme(): {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    persistTheme(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme =
        getThemeDefinition(prev).appearance === "dark" ? "light" : "dark";
      persistTheme(next);
      return next;
    });
  }, []);

  return { theme, setTheme, toggle };
}
